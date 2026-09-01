import { Router } from 'express';
import { z } from 'zod';
import { db, tx } from '../db/index.ts';
import { requireApproved, requireAuth, requireTO, requireUser } from '../lib/auth.ts';
import { badRequest } from '../lib/errors.ts';
import { subordinateIds } from '../lib/org.ts';
import { notifyMany } from '../lib/notify.ts';
import { carTravelerIds, getTripOr404, listCycles, loadCycleParticipants, toBusParticipant } from '../lib/trips.ts';
import { allocateBuses, type BusAllocationResult } from '../services/busAllocation.ts';

export const busesRouter = Router();

busesRouter.use(requireAuth, requireApproved);

const idParam = z.coerce.number().int().positive();

interface CycleBusResult {
  cycleId: number;
  cycleName: string;
  exitDate: string;
  /** כמה מהמשתתפים בפעימה נוסעים ברכב פרטי מאושר (נהג + נוסע) - לא נכנסים לחישוב. */
  carCount: number;
  result: BusAllocationResult;
}

/**
 * מריץ את מנוע השיבוץ לכל פעימות הגלישה. אוטובוסים מחושבים בנפרד לכל פעימה.
 * מי שנוסע ברכב פרטי מאושר (נהג או נוסע) מוסר מהרשימה לפני החישוב - הוא
 * לא תופס מקום באוטובוס.
 */
function computeAllCycles(tripId: number, capacity: number): CycleBusResult[] {
  return listCycles(tripId).map((cycle) => {
    const participants = loadCycleParticipants(cycle.id);
    const carIds = carTravelerIds(participants);
    const busParticipants = participants.filter((person) => !carIds.has(person.userId));
    return {
      cycleId: cycle.id,
      cycleName: cycle.name,
      exitDate: cycle.exit_date,
      carCount: carIds.size,
      result: allocateBuses(busParticipants.map(toBusParticipant), capacity),
    };
  });
}

/**
 * מי מגיע ברכב פרטי ולא באוטובוס, מקובץ לפי פעימה.
 *
 * שני מקורות: בקשות שאושרו (`car_status = 'approved'`) - בקשה ממתינה עדיין
 * לא מוציאה אף אחד מהאוטובוס; ורת״ח/מפמ״ר, שמוחרגים תמיד בלי קשר לבקשה -
 * ראו alwaysBringsOwnCar ב-lib/cars.ts. לכל רכב נהג ולכל היותר נוסע אחד, ולכן
 * `people` סופר את שניהם: זה מספר האנשים שאינם צריכים מקום באוטובוס.
 *
 * `visibleIds` הוא סינון ההרשאות: null = אופרטיבי שרואה הכול, אחרת רק
 * המשתמש עצמו והכפופים לו - אותו כלל כמו ברשימת האוטובוסים.
 */
function loadCarTravelers(tripId: number, visibleIds: Set<number> | null) {
  const rows = db
    .prepare(
      `SELECT c.id AS cycle_id, c.name AS cycle_name, c.exit_date,
              d.id AS driver_id, d.first_name AS driver_first, d.last_name AS driver_last,
              d.company_id AS driver_cid, d.car_plate AS driver_plate,
              p.id AS passenger_id, p.first_name AS passenger_first, p.last_name AS passenger_last,
              p.company_id AS passenger_cid
         FROM signups s
         JOIN cycles c ON c.id = s.cycle_id
         JOIN users d ON d.id = s.user_id
         LEFT JOIN users p ON p.id = s.car_passenger_id
        WHERE s.trip_id = ? AND s.status = 'approved'
          AND (s.car_status = 'approved' OR d.role IN ('division_leader', 'ceo'))
        ORDER BY c.exit_date, d.last_name, d.first_name`,
    )
    .all(tripId) as Array<{
    cycle_id: number;
    cycle_name: string;
    exit_date: string;
    driver_id: number;
    driver_first: string;
    driver_last: string;
    driver_cid: string;
    driver_plate: string | null;
    passenger_id: number | null;
    passenger_first: string | null;
    passenger_last: string | null;
    passenger_cid: string | null;
  }>;

  const cycles = new Map<
    number,
    {
      cycleId: number;
      cycleName: string;
      exitDate: string;
      cars: Array<{
        driver: { userId: number; fullName: string; companyId: string; carPlate: string | null };
        passenger: { userId: number; fullName: string; companyId: string; carPlate: string | null } | null;
      }>;
      people: number;
    }
  >();

  for (const row of rows) {
    // רכב מוצג אם הנהג או הנוסע נראים למשתמש - מפקד רואה את מי שנוסע עם האנשים שלו.
    const driverVisible = !visibleIds || visibleIds.has(row.driver_id);
    const passengerVisible =
      row.passenger_id != null && (!visibleIds || visibleIds.has(row.passenger_id));
    if (!driverVisible && !passengerVisible) continue;

    let cycle = cycles.get(row.cycle_id);
    if (!cycle) {
      cycle = {
        cycleId: row.cycle_id,
        cycleName: row.cycle_name,
        exitDate: row.exit_date,
        cars: [],
        people: 0,
      };
      cycles.set(row.cycle_id, cycle);
    }

    cycle.cars.push({
      driver: {
        userId: row.driver_id,
        fullName: `${row.driver_first} ${row.driver_last}`,
        companyId: row.driver_cid,
        carPlate: row.driver_plate,
      },
      passenger:
        row.passenger_id != null
          ? {
              userId: row.passenger_id,
              fullName: `${row.passenger_first} ${row.passenger_last}`,
              companyId: row.passenger_cid!,
              carPlate: null,
            }
          : null,
    });
    cycle.people += row.passenger_id != null ? 2 : 1;
  }

  const list = [...cycles.values()];
  return {
    totalPeople: list.reduce((sum, cycle) => sum + cycle.people, 0),
    totalCars: list.reduce((sum, cycle) => sum + cycle.cars.length, 0),
    cycles: list,
  };
}

/**
 * נעילת שיבוץ האוטובוסים - אופרטיבי בלבד.
 * מריץ את החלוקה, שומר אותה, ומודיע לכל המשתתפים ולמפקדיהם.
 */
busesRouter.post('/:id/buses/lock', requireTO, (req, res) => {
  const trip = getTripOr404(idParam.parse(req.params.id));
  if (trip.buses_locked_at) throw badRequest('שיבוץ האוטובוסים כבר נעול');

  const computed = computeAllCycles(trip.id, trip.bus_capacity);
  const total = computed.reduce((sum, entry) => sum + entry.result.totalParticipants + entry.carCount, 0);
  if (total === 0) throw badRequest('אין נרשמים מאושרים לגלישה - אין מה לשבץ');

  tx(() => {
    db.prepare('DELETE FROM bus_assignments WHERE trip_id = ?').run(trip.id);
    const insert = db.prepare(
      'INSERT INTO bus_assignments (trip_id, cycle_id, user_id, bus_number) VALUES (?, ?, ?, ?)',
    );

    const participantIds: number[] = [];
    for (const entry of computed) {
      for (const assignment of entry.result.assignments) {
        insert.run(trip.id, entry.cycleId, assignment.userId, assignment.busNumber);
        participantIds.push(assignment.userId);
      }
    }

    db.prepare("UPDATE trips SET buses_locked_at = datetime('now') WHERE id = ?").run(trip.id);

    notifyMany(db, participantIds, {
      kind: 'buses_published',
      title: 'שיבוץ האוטובוסים פורסם',
      body: `שיבוץ האוטובוסים לגלישה ${trip.name} פורסם. אפשר לראות את מספר האוטובוס שלך בסיכום הגלישה.`,
      link: `/trips/${trip.id}`,
    });

    // מפקדים מקבלים התראה נפרדת עם הפניה לרשימה של האנשים שלהם.
    const managerIds = (
      db
        .prepare(
          `SELECT DISTINCT u.manager_id AS id
             FROM bus_assignments b JOIN users u ON u.id = b.user_id
            WHERE b.trip_id = ? AND u.manager_id IS NOT NULL`,
        )
        .all(trip.id) as Array<{ id: number }>
    ).map((row) => row.id);

    notifyMany(db, managerIds, {
      kind: 'buses_published_manager',
      title: 'רשימת האוטובוסים של האנשים שלך',
      body: `שיבוץ האוטובוסים לגלישה ${trip.name} פורסם. אפשר לראות היכן משובצים האנשים שלך.`,
      link: `/trips/${trip.id}/buses`,
    });
  });

  res.json({ ok: true, buses: computed });
});

/** ביטול נעילה - מאפשר תיקון נתונים והרצה מחדש. */
busesRouter.post('/:id/buses/unlock', requireTO, (req, res) => {
  const trip = getTripOr404(idParam.parse(req.params.id));
  if (!trip.buses_locked_at) throw badRequest('שיבוץ האוטובוסים אינו נעול');

  tx(() => {
    db.prepare('DELETE FROM bus_assignments WHERE trip_id = ?').run(trip.id);
    db.prepare('UPDATE trips SET buses_locked_at = NULL WHERE id = ?').run(trip.id);
  });

  res.json({ ok: true });
});

/**
 * תצוגה מקדימה של החלוקה לפני נעילה - אופרטיבי בלבד.
 * לא נשמר במסד ולא נשלחות התראות.
 */
busesRouter.get('/:id/buses/preview', requireTO, (req, res) => {
  const trip = getTripOr404(idParam.parse(req.params.id));
  res.json({ capacity: trip.bus_capacity, cycles: computeAllCycles(trip.id, trip.bus_capacity) });
});

/**
 * שיבוץ האוטובוסים השמור.
 * אופרטיבי מקבל את הרשימה המלאה; מפקד רק את האנשים שלו.
 */
busesRouter.get('/:id/buses', (req, res) => {
  const user = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));

  const visibleIds = user.role === 'to' ? null : new Set([user.id, ...subordinateIds(db, user.id)]);

  if (!trip.buses_locked_at) {
    // הרכבים הפרטיים אינם תלויים בנעילת האוטובוסים, ולכן מוחזרים גם כשהשיבוץ
    // עוד לא פורסם - כך אפשר לראות כמה אנשים כבר לא צריכים מקום באוטובוס.
    res.json({ locked: false, cycles: [], cars: loadCarTravelers(trip.id, visibleIds) });
    return;
  }

  const rows = db
    .prepare(
      `SELECT b.cycle_id, b.bus_number, b.user_id, u.first_name, u.last_name, u.company_id, u.gender, u.diet,
              c.name AS cycle_name, c.exit_date
         FROM bus_assignments b
         JOIN users u ON u.id = b.user_id
         JOIN cycles c ON c.id = b.cycle_id
        WHERE b.trip_id = ?
        ORDER BY c.exit_date, b.bus_number, u.last_name, u.first_name`,
    )
    .all(trip.id) as Array<{
    cycle_id: number;
    bus_number: number;
    user_id: number;
    first_name: string;
    last_name: string;
    company_id: string;
    gender: string;
    diet: string;
    cycle_name: string;
    exit_date: string;
  }>;

  const cycles = new Map<
    number,
    {
      cycleId: number;
      cycleName: string;
      exitDate: string;
      buses: Map<number, Array<{ userId: number; fullName: string; companyId: string; gender: string; diet: string }>>;
      totalAll: number;
      carCount: number;
    }
  >();

  const getOrCreateCycle = (cycleId: number, cycleName: string, exitDate: string) => {
    let cycle = cycles.get(cycleId);
    if (!cycle) {
      cycle = { cycleId, cycleName, exitDate, buses: new Map(), totalAll: 0, carCount: 0 };
      cycles.set(cycleId, cycle);
    }
    return cycle;
  };

  for (const row of rows) {
    const cycle = getOrCreateCycle(row.cycle_id, row.cycle_name, row.exit_date);
    cycle.totalAll += 1;

    if (visibleIds && !visibleIds.has(row.user_id)) continue;
    const list = cycle.buses.get(row.bus_number) ?? [];
    list.push({
      userId: row.user_id,
      fullName: `${row.first_name} ${row.last_name}`,
      companyId: row.company_id,
      gender: row.gender,
      diet: row.diet,
    });
    cycle.buses.set(row.bus_number, list);
  }

  // מי שנוסע ברכב פרטי מאושר (נהג + נוסע), או רת״ח/מפמ״ר שמוחרגים תמיד -
  // לא מופיעים ב-bus_assignments אבל עדיין חלק מהפעימה, ולכן נספרים בנפרד.
  const carRows = db
    .prepare(
      `SELECT s.cycle_id, s.user_id, s.car_passenger_id, c.name AS cycle_name, c.exit_date
         FROM signups s
         JOIN cycles c ON c.id = s.cycle_id
         JOIN users u ON u.id = s.user_id
        WHERE s.trip_id = ? AND (s.car_status = 'approved' OR u.role IN ('division_leader', 'ceo'))`,
    )
    .all(trip.id) as Array<{
    cycle_id: number;
    user_id: number;
    car_passenger_id: number | null;
    cycle_name: string;
    exit_date: string;
  }>;

  for (const row of carRows) {
    const cycle = getOrCreateCycle(row.cycle_id, row.cycle_name, row.exit_date);
    const travelerIds = [row.user_id, ...(row.car_passenger_id != null ? [row.car_passenger_id] : [])];
    for (const travelerId of travelerIds) {
      if (!visibleIds || visibleIds.has(travelerId)) cycle.carCount += 1;
    }
  }

  res.json({
    locked: true,
    lockedAt: trip.buses_locked_at,
    capacity: trip.bus_capacity,
    scope: user.role === 'to' ? 'all' : 'my-people',
    cars: loadCarTravelers(trip.id, visibleIds),
    cycles: [...cycles.values()].map((cycle) => ({
      cycleId: cycle.cycleId,
      cycleName: cycle.cycleName,
      exitDate: cycle.exitDate,
      totalParticipants: cycle.totalAll,
      carCount: cycle.carCount,
      buses: [...cycle.buses.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([number, members]) => ({ number, count: members.length, members })),
    })),
  });
});

/** מספר האוטובוס של המשתמש המחובר - מוצג בסיכום הגלישה האישי. */
busesRouter.get('/:id/buses/mine', (req, res) => {
  const user = requireUser(req);
  const trip = getTripOr404(idParam.parse(req.params.id));

  const row = db
    .prepare(
      `SELECT b.bus_number, c.name AS cycle_name, c.exit_date
         FROM bus_assignments b JOIN cycles c ON c.id = b.cycle_id
        WHERE b.trip_id = ? AND b.user_id = ?`,
    )
    .get(trip.id, user.id) as { bus_number: number; cycle_name: string; exit_date: string } | undefined;

  res.json({
    locked: trip.buses_locked_at != null,
    assignment: row ? { busNumber: row.bus_number, cycleName: row.cycle_name, exitDate: row.exit_date } : null,
  });
});

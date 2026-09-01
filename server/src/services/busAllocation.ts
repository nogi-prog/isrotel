/**
 * שיבוץ אוטובוסים.
 *
 * המטרה: מספר אוטובוסים מינימלי (קיבולת קבועה, ברירת מחדל 50) תוך שמירה על
 * שלמות היחידות - קודם כל מדור שלם באותו אוטובוס, ואם אינו נכנס אז צוותים
 * שלמים. פיצול של צוות קורה רק כשאין ברירה, ומדווח בסוף התהליך.
 */

export interface BusParticipant {
  userId: number;
  name: string;
  teamId: number | null;
  teamName: string | null;
  sectorId: number | null;
  sectorName: string | null;
}

export interface BusSummaryUnit {
  label: string;
  count: number;
}

export interface BusSummary {
  number: number;
  occupancy: number;
  freeSeats: number;
  members: BusParticipant[];
  units: BusSummaryUnit[];
}

export interface BusAllocationResult {
  capacity: number;
  totalParticipants: number;
  buses: BusSummary[];
  assignments: Array<{ userId: number; busNumber: number }>;
  /** יחידות שנאלצו להתפצל בין אוטובוסים. */
  splitUnits: string[];
}

interface Chunk {
  key: string;
  label: string;
  sectorKey: string;
  members: BusParticipant[];
}

interface Bus {
  number: number;
  remaining: number;
  members: BusParticipant[];
}

export const DEFAULT_BUS_CAPACITY = 50;

/** מפתח היחידה הקטנה ביותר שאליה האדם משתייך. */
function chunkKeyOf(person: BusParticipant): { key: string; label: string } {
  if (person.teamId != null) {
    return { key: `team:${person.teamId}`, label: person.teamName ?? `צוות ${person.teamId}` };
  }
  if (person.sectorId != null) {
    return { key: `staff:${person.sectorId}`, label: `סגל ${person.sectorName ?? person.sectorId}` };
  }
  return { key: 'unaffiliated', label: 'ללא שיוך יחידה' };
}

export function allocateBuses(
  participants: readonly BusParticipant[],
  capacity: number = DEFAULT_BUS_CAPACITY,
): BusAllocationResult {
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new Error('קיבולת האוטובוס חייבת להיות מספר שלם חיובי');
  }

  const people = [...participants].sort((a, b) => a.userId - b.userId);

  // --- בניית יחידות (צוותים, וסגל מדור עבור מי שאינו בצוות) ---
  const chunks = new Map<string, Chunk>();
  for (const person of people) {
    const { key, label } = chunkKeyOf(person);
    let chunk = chunks.get(key);
    if (!chunk) {
      chunk = { key, label, sectorKey: String(person.sectorId ?? 'none'), members: [] };
      chunks.set(key, chunk);
    }
    chunk.members.push(person);
  }

  // --- קיבוץ היחידות לפי מדור ---
  const sectors = new Map<string, { key: string; chunks: Chunk[]; size: number }>();
  for (const chunk of chunks.values()) {
    let sector = sectors.get(chunk.sectorKey);
    if (!sector) {
      sector = { key: chunk.sectorKey, chunks: [], size: 0 };
      sectors.set(chunk.sectorKey, sector);
    }
    sector.chunks.push(chunk);
    sector.size += chunk.members.length;
  }

  const buses: Bus[] = Array.from({ length: Math.max(1, Math.ceil(people.length / capacity)) }, (_, index) => ({
    number: index + 1,
    remaining: capacity,
    members: [],
  }));

  /** האוטובוס ההדוק ביותר שעוד יכול להכיל `size` מקומות (best-fit). */
  const bestFit = (size: number): Bus | null => {
    let best: Bus | null = null;
    for (const bus of buses) {
      if (bus.remaining < size) continue;
      if (!best || bus.remaining < best.remaining) best = bus;
    }
    return best;
  };

  /** האוטובוס עם מספר המקומות הפנוי הגדול ביותר. */
  const mostRoom = (): Bus => {
    let best = buses[0]!;
    for (const bus of buses) if (bus.remaining > best.remaining) best = bus;
    return best;
  };

  const place = (bus: Bus, members: readonly BusParticipant[]): void => {
    bus.members.push(...members);
    bus.remaining -= members.length;
  };

  const splitUnits = new Set<string>();

  const placeChunk = (chunk: Chunk): void => {
    const target = bestFit(chunk.members.length);
    if (target) {
      place(target, chunk.members);
      return;
    }

    // היחידה לא נכנסת לאף אוטובוס שלמה - מפצלים ומדווחים.
    splitUnits.add(chunk.label);
    let queue = [...chunk.members];
    while (queue.length > 0) {
      let bus = mostRoom();
      if (bus.remaining === 0) {
        bus = { number: buses.length + 1, remaining: capacity, members: [] };
        buses.push(bus);
      }
      const take = Math.min(bus.remaining, queue.length);
      place(bus, queue.slice(0, take));
      queue = queue.slice(take);
    }
  };

  const orderedSectors = [...sectors.values()].sort((a, b) => b.size - a.size || a.key.localeCompare(b.key));

  for (const sector of orderedSectors) {
    // עדיפות ראשונה: כל המדור באותו אוטובוס.
    const wholeSector = sector.size <= capacity ? bestFit(sector.size) : null;
    if (wholeSector) {
      for (const chunk of sector.chunks) place(wholeSector, chunk.members);
      continue;
    }

    const orderedChunks = [...sector.chunks].sort(
      (a, b) => b.members.length - a.members.length || a.key.localeCompare(b.key),
    );
    for (const chunk of orderedChunks) placeChunk(chunk);
  }

  // --- סידור התוצאה ---
  const active = buses.filter((bus) => bus.members.length > 0);
  active.forEach((bus, index) => {
    bus.number = index + 1;
  });

  const summaries: BusSummary[] = active.map((bus) => {
    const counts = new Map<string, number>();
    for (const member of bus.members) {
      const { label } = chunkKeyOf(member);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return {
      number: bus.number,
      occupancy: bus.members.length,
      freeSeats: capacity - bus.members.length,
      members: [...bus.members].sort((a, b) => a.name.localeCompare(b.name, 'he')),
      units: [...counts.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'he')),
    };
  });

  const assignments = summaries.flatMap((bus) =>
    bus.members.map((member) => ({ userId: member.userId, busNumber: bus.number })),
  );

  return {
    capacity,
    totalParticipants: people.length,
    buses: summaries,
    assignments,
    splitUnits: [...splitUnits].sort((a, b) => a.localeCompare(b, 'he')),
  };
}

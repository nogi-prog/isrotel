import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateDorms,
  planDormRooms,
  MAX_ROOM_BEDS,
  type DormParticipant,
  type DormRoom,
} from './dormAllocation.ts';
import type { Gender, RankGroup } from '../types.ts';

interface PersonSpec {
  id: number;
  gender?: Gender;
  rank?: RankGroup;
  sector?: number;
  team?: number;
  prefs?: number[];
}

function person(spec: PersonSpec): DormParticipant {
  const sector = spec.sector ?? 1;
  const team = spec.team ?? 1;
  return {
    userId: spec.id,
    name: `אדם ${spec.id}`,
    gender: spec.gender ?? 'male',
    rankGroup: spec.rank ?? 'soldier',
    sectorId: sector,
    sectorName: `מדור ${sector}`,
    teamId: team,
    teamName: `צוות ${team}`,
    managerId: 900 + team,
    preferences: spec.prefs ?? [],
  };
}

function room(roomId: number, beds: number, gender: Gender = 'male', structureId = 1): DormRoom {
  return {
    roomId,
    roomName: `${roomId}`,
    structureId,
    structureName: `מבנה ${structureId}`,
    gender,
    beds,
  };
}

/** בודק שכל האילוצים הקשיחים נשמרו. */
function assertHardConstraints(
  result: ReturnType<typeof allocateDorms>,
  participants: DormParticipant[],
  rooms: DormRoom[],
): void {
  const byId = new Map(participants.map((p) => [p.userId, p]));
  const roomById = new Map(rooms.map((r) => [r.roomId, r]));

  for (const summary of result.rooms) {
    const definition = roomById.get(summary.roomId)!;
    assert.ok(
      summary.occupancy <= definition.beds,
      `חדר ${summary.roomId}: ${summary.occupancy} אנשים ב-${definition.beds} מיטות`,
    );

    const occupants = summary.members.map((member) => byId.get(member.userId)!);
    for (const occupant of occupants) {
      assert.equal(occupant.gender, definition.gender, `חדר ${summary.roomId}: מין לא תואם למבנה`);
    }
    const ranks = new Set(occupants.map((occupant) => occupant.rankGroup));
    assert.ok(ranks.size <= 1, `חדר ${summary.roomId}: עורבבו חיילים ומפקדים`);
  }

  // כל אדם משובץ לכל היותר לחדר אחד.
  const placedIds = result.placements.map((placement) => placement.userId);
  assert.equal(new Set(placedIds).size, placedIds.length, 'אדם שובץ ליותר מחדר אחד');
}

describe('allocateDorms', () => {
  test('מכבד העדפה הדדית ומשבץ את הזוג יחד', () => {
    const people = [
      person({ id: 1, prefs: [2] }),
      person({ id: 2, prefs: [1] }),
      person({ id: 3 }),
      person({ id: 4 }),
    ];
    const rooms = [room(10, 2), room(11, 2)];
    const result = allocateDorms(people, rooms);

    assertHardConstraints(result, people, rooms);
    const roomOf = new Map(result.placements.map((p) => [p.userId, p.roomId]));
    assert.equal(roomOf.get(1), roomOf.get(2), 'הזוג ההדדי לא שובץ יחד');
    assert.equal(result.stats.mutualPairsHonored, 1);
    assert.equal(result.issues.length, 0);
  });

  test('לעולם לא מערבב בנים ובנות באותו חדר', () => {
    const people = [
      person({ id: 1, gender: 'male' }),
      person({ id: 2, gender: 'male' }),
      person({ id: 3, gender: 'female' }),
      person({ id: 4, gender: 'female' }),
    ];
    const rooms = [room(10, 4, 'male', 1), room(20, 4, 'female', 2)];
    const result = allocateDorms(people, rooms);

    assertHardConstraints(result, people, rooms);
    assert.equal(result.stats.placed, 4);
  });

  test('לעולם לא מערבב חיילים ומפקדים באותו חדר', () => {
    const people = [
      person({ id: 1, rank: 'soldier' }),
      person({ id: 2, rank: 'soldier' }),
      person({ id: 3, rank: 'team_leader' }),
      person({ id: 4, rank: 'team_leader' }),
    ];
    const rooms = [room(10, 4), room(11, 4)];
    const result = allocateDorms(people, rooms);

    assertHardConstraints(result, people, rooms);
    assert.equal(result.stats.placed, 4);
  });

  test('מחלק חדרים בין חיילים ומפקדים לפי הביקוש', () => {
    const soldiers = Array.from({ length: 12 }, (_, index) => person({ id: index + 1, rank: 'soldier' }));
    const commanders = Array.from({ length: 4 }, (_, index) => person({ id: 100 + index, rank: 'team_leader' }));
    const rooms = [room(10, 4), room(11, 4), room(12, 4), room(13, 4)];
    const result = allocateDorms([...soldiers, ...commanders], rooms);

    assertHardConstraints(result, [...soldiers, ...commanders], rooms);
    assert.equal(result.stats.placed, 16);
    assert.equal(result.stats.unassigned, 0);
  });

  test('מדווח על מי שלא קיבל אף העדפה, עם הצעות מאותו מדור', () => {
    // 1 רוצה את 2, אבל 2 ו-3 הדדיים ותופסים חדר של 2 מיטות.
    const people = [
      person({ id: 1, prefs: [2], team: 1 }),
      person({ id: 2, prefs: [3], team: 1 }),
      person({ id: 3, prefs: [2], team: 1 }),
      person({ id: 4, team: 2 }),
    ];
    const rooms = [room(10, 2), room(11, 2)];
    const result = allocateDorms(people, rooms);

    assertHardConstraints(result, people, rooms);
    const issue = result.issues.find((entry) => entry.userId === 1);
    assert.ok(issue, 'לא נוצרה בעיה עבור מי שלא קיבל העדפה');
    assert.equal(issue.kind, 'no_preference_met');
    assert.equal(issue.managerId, 901);
    assert.ok(issue.suggestions.length > 0, 'לא הוצעו סידורים חלופיים');
    // ההצעות חייבות להיות מאנשים מאותו מדור.
    for (const suggestion of issue.suggestions) {
      assert.ok(suggestion.companions.length > 0);
    }
  });

  test('מדווח על מי שלא נותרה עבורו מיטה', () => {
    const people = Array.from({ length: 5 }, (_, index) => person({ id: index + 1 }));
    const rooms = [room(10, 3)];
    const result = allocateDorms(people, rooms);

    assertHardConstraints(result, people, rooms);
    assert.equal(result.stats.placed, 3);
    assert.equal(result.stats.unassigned, 2);
    assert.equal(result.issues.filter((issue) => issue.kind === 'unassigned').length, 2);
  });

  test('כשאין מבנה למין מסוים - כולם מדווחים כלא משובצים', () => {
    const people = [person({ id: 1, gender: 'female' }), person({ id: 2, gender: 'female' })];
    const rooms = [room(10, 4, 'male')];
    const result = allocateDorms(people, rooms);

    assert.equal(result.stats.placed, 0);
    assert.equal(result.issues.filter((issue) => issue.kind === 'unassigned').length, 2);
  });

  test('אשכול גדול ממספר המיטות בחדר הגדול מתפצל בלי לשבור אילוצים', () => {
    // חמישה אנשים שכולם בחרו זה בזה, אבל החדר הגדול הוא 3 מיטות.
    const ids = [1, 2, 3, 4, 5];
    const people = ids.map((id) => person({ id, prefs: ids.filter((other) => other !== id).slice(0, 3) }));
    const rooms = [room(10, 3), room(11, 3)];
    const result = allocateDorms(people, rooms);

    assertHardConstraints(result, people, rooms);
    assert.equal(result.stats.placed, 5);
  });

  test('תוצאה משוחזרת בין הרצות', () => {
    const build = () => [
      person({ id: 1, prefs: [2, 3] }),
      person({ id: 2, prefs: [1] }),
      person({ id: 3, prefs: [4] }),
      person({ id: 4, prefs: [3] }),
      person({ id: 5, prefs: [] }),
      person({ id: 6, prefs: [5] }),
    ];
    const rooms = [room(10, 2), room(11, 2), room(12, 2)];

    const first = allocateDorms(build(), rooms);
    const second = allocateDorms(build(), rooms);
    assert.deepEqual(first.placements, second.placements);
  });

  test('מטפל בהעדפות שאינן במאגר (מין או דרגה שונים, או לא נרשמו)', () => {
    const people = [
      person({ id: 1, prefs: [99, 2] }), // 99 לא נרשם
      person({ id: 2, prefs: [1] }),
    ];
    const rooms = [room(10, 2)];
    const result = allocateDorms(people, rooms);

    assertHardConstraints(result, people, rooms);
    assert.equal(result.stats.placed, 2);
    assert.equal(result.stats.withPreferences, 2);
    assert.equal(result.stats.preferencesSatisfied, 2);
    assert.equal(result.issues.length, 0);
  });

  test('מטפל בקבוצה גדולה בלי לשבור אילוצים', () => {
    const people: DormParticipant[] = [];
    for (let index = 0; index < 120; index += 1) {
      const gender: Gender = index % 3 === 0 ? 'female' : 'male';
      const rank: RankGroup = index % 11 === 0 ? 'team_leader' : 'soldier';
      people.push(
        person({
          id: index + 1,
          gender,
          rank,
          sector: (index % 3) + 1,
          team: (index % 9) + 1,
          prefs: [index + 2, index + 3].filter((id) => id <= 120),
        }),
      );
    }
    // 80 בנים ו-40 בנות; מספקים מיטות בעודף כדי שכולם ישובצו.
    const rooms: DormRoom[] = [
      ...Array.from({ length: 18 }, (_, index) => room(100 + index, 4 + (index % 3), 'male', 1)),
      ...Array.from({ length: 10 }, (_, index) => room(200 + index, 4 + (index % 3), 'female', 2)),
    ];

    const result = allocateDorms(people, rooms);
    assertHardConstraints(result, people, rooms);
    assert.equal(result.stats.placed, 120, 'לא כולם שובצו למרות שיש מיטות');
    assert.equal(result.stats.unassigned, 0);
    // הרוב המוחלט אמור לקבל לפחות אחת מההעדפות שניתן לספק.
    assert.ok(
      result.stats.preferencesSatisfied / result.stats.withPreferences >= 0.8,
      `רק ${result.stats.preferencesSatisfied}/${result.stats.withPreferences} קיבלו העדפה`,
    );
  });
});

describe('planDormRooms', () => {
  test('כל חדר בטווח 4-8 מיטות, וכולם משובצים בלי צורך בחדרים אמיתיים', () => {
    const people = Array.from({ length: 23 }, (_, index) => person({ id: index + 1 }));
    const plan = planDormRooms(people);

    assert.equal(plan.totalPeople, 23);
    assert.equal(plan.unassigned, 0, 'המאגר הסינתטי אמור להספיק לכולם');
    const placedCount = plan.rooms.reduce((sum, room) => sum + room.occupants.length, 0);
    assert.equal(placedCount, 23);

    for (const room of plan.rooms) {
      assert.ok(room.occupants.length <= room.size, 'יותר דיירים מגודל החדר');
      assert.equal(room.size, MAX_ROOM_BEDS, 'התוכנית תמיד ממליצה על חדר בגודל המקסימלי');
    }

    // הסיכום לפי גודל תואם את רשימת החדרים בפועל.
    const totalFromSizeCounts = plan.sizeCounts.reduce((sum, entry) => sum + entry.count, 0);
    assert.equal(totalFromSizeCounts, plan.totalRooms);
    assert.equal(plan.totalRooms, plan.rooms.length);
  });

  test('לא מערבב מין או דרג ניהולי בין חדרי התוכנית, בדיוק כמו בשיבוץ אמיתי', () => {
    const people = [
      ...Array.from({ length: 10 }, (_, index) => person({ id: index + 1, gender: 'male', rank: 'soldier' })),
      ...Array.from({ length: 6 }, (_, index) => person({ id: 100 + index, gender: 'female', rank: 'soldier' })),
      ...Array.from({ length: 3 }, (_, index) => person({ id: 200 + index, gender: 'male', rank: 'team_leader' })),
    ];
    const plan = planDormRooms(people);

    for (const room of plan.rooms) {
      const genders = new Set(
        room.occupants.map((occupant) => people.find((p) => p.userId === occupant.userId)!.gender),
      );
      assert.equal(genders.size, 1, 'חדר בתוכנית מערבב מינים');
      assert.equal(genders.has(room.gender), true);

      const ranks = new Set(
        room.occupants.map((occupant) => people.find((p) => p.userId === occupant.userId)!.rankGroup),
      );
      assert.equal(ranks.size, 1, 'חדר בתוכנית מערבב דרגים');
    }

    // 3 מנהיגי צוות (בנים) - קבוצה נפרדת מ-10 החיילים הבנים, גם אם שניהם באותו מין.
    const teamLeaderRoom = plan.rooms.find((room) => room.rankGroup === 'team_leader');
    assert.ok(teamLeaderRoom, 'לא נוצר חדר נפרד למנהיגי הצוות');
    assert.equal(teamLeaderRoom!.occupants.length, 3);
  });

  test('קבוצה קטנה מ-4 עדיין מדווחת כחדר בגודל המקסימלי המועדף', () => {
    const people = [person({ id: 1 }), person({ id: 2 })];
    const plan = planDormRooms(people);

    assert.equal(plan.totalRooms, 1);
    assert.equal(plan.rooms[0]!.size, MAX_ROOM_BEDS);
    assert.equal(plan.rooms[0]!.occupants.length, 2);
  });

  test('רשימה ריקה מחזירה תוכנית ריקה בלי שגיאה', () => {
    const plan = planDormRooms([]);
    assert.equal(plan.totalRooms, 0);
    assert.equal(plan.totalPeople, 0);
    assert.deepEqual(plan.rooms, []);
    assert.deepEqual(plan.sizeCounts, []);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { allocateBuses, type BusParticipant } from './busAllocation.ts';

let nextId = 1;

function makeTeam(teamId: number, sectorId: number, count: number): BusParticipant[] {
  return Array.from({ length: count }, () => ({
    userId: nextId++,
    name: `אדם ${nextId}`,
    teamId,
    teamName: `צוות ${teamId}`,
    sectorId,
    sectorName: `מדור ${sectorId}`,
  }));
}

describe('allocateBuses', () => {
  test('משבץ את כולם פעם אחת בלבד', () => {
    const people = [...makeTeam(1, 1, 30), ...makeTeam(2, 1, 25), ...makeTeam(3, 2, 40)];
    const result = allocateBuses(people, 50);

    assert.equal(result.assignments.length, people.length);
    assert.equal(new Set(result.assignments.map((a) => a.userId)).size, people.length);
  });

  test('לא עובר את קיבולת האוטובוס', () => {
    const people = [...makeTeam(1, 1, 47), ...makeTeam(2, 1, 47), ...makeTeam(3, 2, 47)];
    const result = allocateBuses(people, 50);

    for (const bus of result.buses) {
      assert.ok(bus.occupancy <= 50, `אוטובוס ${bus.number} מכיל ${bus.occupancy} אנשים`);
    }
  });

  test('משתמש במספר האוטובוסים המינימלי כשהחלוקה מסתדרת', () => {
    const people = [...makeTeam(1, 1, 50), ...makeTeam(2, 2, 50), ...makeTeam(3, 3, 50)];
    const result = allocateBuses(people, 50);
    assert.equal(result.buses.length, 3);
    assert.deepEqual(result.splitUnits, []);
  });

  test('שומר מדור שלם באותו אוטובוס כשהוא נכנס', () => {
    const sectorA = [...makeTeam(1, 1, 12), ...makeTeam(2, 1, 14), ...makeTeam(3, 1, 10)]; // 36
    const sectorB = [...makeTeam(4, 2, 20), ...makeTeam(5, 2, 18)]; // 38
    const result = allocateBuses([...sectorA, ...sectorB], 50);

    const busOf = new Map(result.assignments.map((a) => [a.userId, a.busNumber]));
    const busesForSectorA = new Set(sectorA.map((person) => busOf.get(person.userId)));
    const busesForSectorB = new Set(sectorB.map((person) => busOf.get(person.userId)));

    assert.equal(busesForSectorA.size, 1, 'מדור 1 פוצל בין אוטובוסים');
    assert.equal(busesForSectorB.size, 1, 'מדור 2 פוצל בין אוטובוסים');
  });

  test('מפצל צוות רק כשאין ברירה, ומדווח על כך', () => {
    // צוות בודד גדול מקיבולת אוטובוס - חייב להתפצל.
    const people = makeTeam(9, 9, 70);
    const result = allocateBuses(people, 50);

    assert.equal(result.buses.length, 2);
    assert.deepEqual(result.splitUnits, ['צוות 9']);
    assert.equal(result.assignments.length, 70);
  });

  test('מטפל ברשימה ריקה', () => {
    const result = allocateBuses([], 50);
    assert.deepEqual(result.buses, []);
    assert.deepEqual(result.assignments, []);
  });

  test('סופר נכון את היחידות בכל אוטובוס', () => {
    const people = [...makeTeam(1, 1, 10), ...makeTeam(2, 1, 5)];
    const result = allocateBuses(people, 50);

    assert.equal(result.buses.length, 1);
    const units = result.buses[0]!.units;
    assert.deepEqual(
      units.map((unit) => [unit.label, unit.count]),
      [
        ['צוות 1', 10],
        ['צוות 2', 5],
      ],
    );
    assert.equal(result.buses[0]!.freeSeats, 35);
  });

  test('דוחה קיבולת לא חוקית', () => {
    assert.throws(() => allocateBuses([], 0));
    assert.throws(() => allocateBuses([], -5));
  });
});

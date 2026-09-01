/**
 * שיבוץ לינה.
 *
 * אילוצים קשיחים (לעולם אינם נשברים):
 *   1. מבנה שלם הוא חד-מיני, ולכן בחדר ישנים רק אנשים מאותו מין.
 *   2. חיילים ישנים עם חיילים, מפקדים עם מפקדים (חדר שלם שייך לקבוצת דרגה אחת).
 *   3. אין יותר אנשים בחדר ממספר המיטות בו.
 *
 * מטרה רכה: לספק לכל אדם לפחות אחת מהעדפות השותפים שלו. העדפה הדדית
 * (שני הצדדים בחרו זה בזה) מקבלת עדיפות גבוהה יותר מהעדפה חד-צדדית.
 *
 * מי שלא קיבל אף אחת מההעדפות שלו, או שלא נותרה עבורו מיטה, מדווח כבעיה
 * לטיפול המפקד שלו - יחד עם הצעות שיבוץ אפשריות מאותו מדור.
 */
import type { Gender, RankGroup } from '../types.ts';

export interface DormParticipant {
  userId: number;
  name: string;
  gender: Gender;
  rankGroup: RankGroup;
  sectorId: number | null;
  sectorName: string | null;
  teamId: number | null;
  teamName: string | null;
  managerId: number | null;
  /** מזהי המשתמשים שנבחרו כשותפים מועדפים, לפי סדר עדיפות. */
  preferences: number[];
}

export interface DormRoom {
  roomId: number;
  roomName: string;
  structureId: number;
  structureName: string;
  gender: Gender;
  beds: number;
}

export interface DormSuggestion {
  kind: 'free_bed' | 'swap_needed';
  roomId: number;
  roomLabel: string;
  freeBeds: number;
  /** אנשים מאותו מדור שנמצאים בחדר הזה. */
  companions: Array<{ userId: number; name: string; teamName: string | null }>;
}

export interface DormIssue {
  userId: number;
  userName: string;
  managerId: number | null;
  kind: 'no_preference_met' | 'unassigned';
  message: string;
  suggestions: DormSuggestion[];
}

export interface DormRoomSummary {
  roomId: number;
  roomName: string;
  structureId: number;
  structureName: string;
  gender: Gender;
  beds: number;
  occupancy: number;
  freeBeds: number;
  rankGroup: RankGroup | null;
  members: Array<{ userId: number; name: string; teamName: string | null; sectorName: string | null }>;
}

export interface DormAllocationResult {
  placements: Array<{ userId: number; roomId: number }>;
  rooms: DormRoomSummary[];
  issues: DormIssue[];
  stats: {
    participants: number;
    placed: number;
    unassigned: number;
    withPreferences: number;
    preferencesSatisfied: number;
    mutualPairsHonored: number;
    totalBeds: number;
  };
}

const roomLabel = (room: DormRoom) => `${room.structureName} / חדר ${room.roomName}`;

/** מפתח מאגר = שילוב מין וקבוצת דרגה. חדר שלם משויך למאגר אחד. */
type PoolKey = `${Gender}:${RankGroup}`;
const poolKeyOf = (gender: Gender, rankGroup: RankGroup): PoolKey => `${gender}:${rankGroup}`;

interface Cluster {
  members: DormParticipant[];
  /** האם האשכול נוצר מהעדפה הדדית - משמש לדיווח. */
  mutual: boolean;
}

/** מבנה איחוד-מצא לבניית אשכולות שותפים. */
class DisjointSets {
  private readonly parent = new Map<number, number>();
  private readonly size = new Map<number, number>();

  add(id: number): void {
    if (!this.parent.has(id)) {
      this.parent.set(id, id);
      this.size.set(id, 1);
    }
  }

  find(id: number): number {
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cursor = id;
    while (cursor !== root) {
      const next = this.parent.get(cursor)!;
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  sizeOf(id: number): number {
    return this.size.get(this.find(id))!;
  }

  /** מאחד שתי קבוצות אם הגודל המשולב אינו עובר את התקרה. */
  union(a: number, b: number, maxSize: number): boolean {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return false;
    const combined = this.size.get(rootA)! + this.size.get(rootB)!;
    if (combined > maxSize) return false;
    const [big, small] = this.size.get(rootA)! >= this.size.get(rootB)! ? [rootA, rootB] : [rootB, rootA];
    this.parent.set(small, big);
    this.size.set(big, combined);
    return true;
  }
}

/**
 * מחלק את חדרי המבנים בין קבוצות הדרגה של אותו מין.
 * בכל צעד החדר הגדול הפנוי ניתן לקבוצה עם החוסר הגדול ביותר במיטות.
 */
function assignRoomsToPools(
  rooms: readonly DormRoom[],
  demand: Map<PoolKey, number>,
): Map<PoolKey, DormRoom[]> {
  const result = new Map<PoolKey, DormRoom[]>();
  const allocated = new Map<PoolKey, number>();
  for (const key of demand.keys()) {
    result.set(key, []);
    allocated.set(key, 0);
  }

  const byGender = new Map<Gender, DormRoom[]>();
  for (const room of rooms) {
    const list = byGender.get(room.gender) ?? [];
    list.push(room);
    byGender.set(room.gender, list);
  }

  for (const [gender, genderRooms] of byGender) {
    // קבוצות הדרגה הן דינמיות (חייל, ולכל דרג ניהולי קבוצה משלו - ראו RankGroup),
    // ולכן נגזרות מהביקוש בפועל של המין הזה, ולא מרשימה קבועה מראש.
    const pools = [...demand.keys()].filter(
      (key) => key.startsWith(`${gender}:`) && (demand.get(key) ?? 0) > 0,
    );
    if (pools.length === 0) continue;

    const ordered = [...genderRooms].sort((a, b) => b.beds - a.beds || a.roomId - b.roomId);
    for (const room of ordered) {
      // הקבוצה שחסרות לה הכי הרבה מיטות מקבלת את החדר.
      let target = pools[0]!;
      let worstDeficit = -Infinity;
      for (const key of pools) {
        const deficit = (demand.get(key) ?? 0) - (allocated.get(key) ?? 0);
        if (deficit > worstDeficit) {
          worstDeficit = deficit;
          target = key;
        }
      }
      if (worstDeficit <= 0) break; // כל הקבוצות מכוסות - שאר החדרים נשארים ריקים
      result.get(target)!.push(room);
      allocated.set(target, (allocated.get(target) ?? 0) + room.beds);
    }
  }

  return result;
}

/** בונה אשכולות שותפים בתוך מאגר, בכפוף לגודל החדר הגדול ביותר במאגר. */
function buildClusters(pool: readonly DormParticipant[], maxClusterSize: number): Cluster[] {
  const byId = new Map(pool.map((person) => [person.userId, person]));
  const sets = new DisjointSets();
  for (const person of pool) sets.add(person.userId);

  const mutualEdges: Array<[number, number]> = [];
  const singleEdges: Array<[number, number, number]> = []; // [a, b, priority]

  for (const person of pool) {
    person.preferences.forEach((otherId, index) => {
      const other = byId.get(otherId);
      if (!other) return; // ההעדפה אינה במאגר (לא נרשם / מין או דרגה שונים)
      const isMutual = other.preferences.includes(person.userId);
      if (isMutual) {
        if (person.userId < other.userId) mutualEdges.push([person.userId, other.userId]);
      } else {
        singleEdges.push([person.userId, other.userId, index]);
      }
    });
  }

  const mutualUnions = new Set<string>();
  // העדפות הדדיות קודם, וביניהן לפי סדר קבוע כדי שהתוצאה תהיה משוחזרת.
  mutualEdges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [a, b] of mutualEdges) {
    if (sets.union(a, b, maxClusterSize)) mutualUnions.add(`${a}-${b}`);
  }

  singleEdges.sort((a, b) => a[2] - b[2] || a[0] - b[0] || a[1] - b[1]);
  for (const [a, b] of singleEdges) sets.union(a, b, maxClusterSize);

  const grouped = new Map<number, DormParticipant[]>();
  for (const person of pool) {
    const root = sets.find(person.userId);
    const list = grouped.get(root) ?? [];
    list.push(person);
    grouped.set(root, list);
  }

  return [...grouped.values()].map((members) => ({
    members: members.sort((a, b) => a.userId - b.userId),
    mutual: members.some((member) =>
      member.preferences.some((otherId) =>
        members.some(
          (candidate) => candidate.userId === otherId && candidate.preferences.includes(member.userId),
        ),
      ),
    ),
  }));
}

/**
 * כשאשכול חייב להתפצל בין חדרים - בוחר ממנו תת-קבוצה בגודל `size` שמשמרת
 * כמה שיותר קשרי העדפה, במקום לפזר אנשים באופן שרירותי.
 */
function peelConnected(members: readonly DormParticipant[], size: number): DormParticipant[] {
  if (size >= members.length) return [...members];

  const inCluster = new Set(members.map((member) => member.userId));
  /** מספר קשרי ההעדפה (בשני הכיוונים) בין אדם לקבוצת מועמדים. */
  const links = (person: DormParticipant, group: readonly DormParticipant[]): number =>
    group.reduce((sum, other) => {
      if (other.userId === person.userId) return sum;
      const forward = person.preferences.includes(other.userId) ? 1 : 0;
      const backward = other.preferences.includes(person.userId) ? 1 : 0;
      // קשר הדדי שווה יותר מקשר חד-צדדי.
      return sum + forward + backward + (forward && backward ? 2 : 0);
    }, 0);

  const degreeWithin = (person: DormParticipant) =>
    links(
      person,
      members.filter((other) => inCluster.has(other.userId)),
    );

  const remaining = [...members];
  const seedIndex = remaining.reduce(
    (best, person, index) =>
      degreeWithin(person) > degreeWithin(remaining[best]!) ||
      (degreeWithin(person) === degreeWithin(remaining[best]!) && person.userId < remaining[best]!.userId)
        ? index
        : best,
    0,
  );

  const selected = [remaining.splice(seedIndex, 1)[0]!];
  while (selected.length < size && remaining.length > 0) {
    // מוסיפים בכל צעד את מי שקשור הכי חזק למי שנבחרו עד כה.
    let bestIndex = 0;
    let bestScore = -Infinity;
    remaining.forEach((person, index) => {
      const score = links(person, selected) * 1000 - person.userId;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    selected.push(remaining.splice(bestIndex, 1)[0]!);
  }

  return selected;
}

/** ניקוד התאמה של אשכול לחדר שכבר מאוכלס - לצורך מילוי מיטות שנותרו. */
function affinity(cluster: Cluster, occupants: readonly DormParticipant[]): number {
  let score = 0;
  for (const member of cluster.members) {
    for (const occupant of occupants) {
      if (member.preferences.includes(occupant.userId)) score += 4;
      if (occupant.preferences.includes(member.userId)) score += 4;
      if (member.teamId != null && member.teamId === occupant.teamId) score += 2;
      else if (member.sectorId != null && member.sectorId === occupant.sectorId) score += 1;
    }
  }
  return score;
}

export function allocateDorms(
  participants: readonly DormParticipant[],
  rooms: readonly DormRoom[],
): DormAllocationResult {
  const people = [...participants].sort((a, b) => a.userId - b.userId);
  const byId = new Map(people.map((person) => [person.userId, person]));

  // --- חלוקה למאגרים לפי מין וקבוצת דרגה ---
  const pools = new Map<PoolKey, DormParticipant[]>();
  for (const person of people) {
    const key = poolKeyOf(person.gender, person.rankGroup);
    const list = pools.get(key) ?? [];
    list.push(person);
    pools.set(key, list);
  }

  const demand = new Map<PoolKey, number>();
  for (const [key, list] of pools) demand.set(key, list.length);

  const roomsByPool = assignRoomsToPools(rooms, demand);

  // --- שיבוץ בתוך כל מאגר ---
  const occupantsByRoom = new Map<number, DormParticipant[]>();
  const roomOf = new Map<number, number>();
  const poolOfRoom = new Map<number, PoolKey>();
  const unassigned: DormParticipant[] = [];

  for (const [poolKey, poolPeople] of pools) {
    const poolRooms = [...(roomsByPool.get(poolKey) ?? [])].sort(
      (a, b) => b.beds - a.beds || a.roomId - b.roomId,
    );
    for (const room of poolRooms) {
      occupantsByRoom.set(room.roomId, []);
      poolOfRoom.set(room.roomId, poolKey);
    }

    if (poolRooms.length === 0) {
      unassigned.push(...poolPeople);
      continue;
    }

    const maxClusterSize = Math.max(...poolRooms.map((room) => room.beds));
    let clusters = buildClusters(poolPeople, maxClusterSize);

    // אשכולות גדולים קודם, כדי שיקבלו את החדרים הגדולים.
    clusters.sort(
      (a, b) =>
        b.members.length - a.members.length ||
        Number(b.mutual) - Number(a.mutual) ||
        a.members[0]!.userId - b.members[0]!.userId,
    );

    const place = (room: DormRoom, cluster: Cluster): void => {
      const occupants = occupantsByRoom.get(room.roomId)!;
      occupants.push(...cluster.members);
      for (const member of cluster.members) roomOf.set(member.userId, room.roomId);
    };

    const freeBeds = (room: DormRoom) => room.beds - (occupantsByRoom.get(room.roomId)?.length ?? 0);

    // החדרים ממולאים מהגדול לקטן, וכל חדר ממולא עד תום לפני המעבר לבא.
    // לכן אשכול שלא נכנס לחדר הנוכחי לא ייכנס גם לאף חדר שאחריו, ומותר לפצל אותו.
    for (const room of poolRooms) {
      while (clusters.length > 0 && freeBeds(room) > 0) {
        const available = freeBeds(room);
        const occupants = occupantsByRoom.get(room.roomId)!;
        const fitting = clusters
          .map((cluster, index) => ({ cluster, index }))
          .filter((entry) => entry.cluster.members.length <= available);

        if (fitting.length > 0) {
          // חדר ריק: מתחילים מהאשכול הגדול. חדר מאוכלס: בוחרים לפי התאמה לשוכנים.
          const best = fitting.reduce((winner, entry) => {
            const score = (candidate: Cluster) =>
              occupants.length === 0
                ? candidate.members.length * 1000 + (candidate.mutual ? 1 : 0)
                : affinity(candidate, occupants) * 1000 + candidate.members.length;
            return score(entry.cluster) > score(winner.cluster) ? entry : winner;
          });
          place(room, best.cluster);
          clusters.splice(best.index, 1);
          continue;
        }

        // אף אשכול אינו נכנס: מפצלים את הגדול, ושומרים יחד את מי שקשור בהעדפות.
        const largestIndex = clusters.reduce(
          (best, cluster, index) => (cluster.members.length > clusters[best]!.members.length ? index : best),
          0,
        );
        const largest = clusters[largestIndex]!;
        const peeled = peelConnected(largest.members, available);
        const peeledIds = new Set(peeled.map((member) => member.userId));
        place(room, { members: peeled, mutual: largest.mutual });

        const remainder = largest.members.filter((member) => !peeledIds.has(member.userId));
        if (remainder.length === 0) clusters.splice(largestIndex, 1);
        else clusters[largestIndex] = { members: remainder, mutual: largest.mutual };
      }
    }

    // מה שנשאר - אין עבורו מיטות במאגר.
    for (const cluster of clusters) unassigned.push(...cluster.members);
    clusters = [];
  }

  // --- סיכום חדרים ---
  const roomById = new Map(rooms.map((room) => [room.roomId, room]));
  const roomSummaries: DormRoomSummary[] = rooms
    .map((room) => {
      const occupants = occupantsByRoom.get(room.roomId) ?? [];
      const poolKey = poolOfRoom.get(room.roomId);
      return {
        roomId: room.roomId,
        roomName: room.roomName,
        structureId: room.structureId,
        structureName: room.structureName,
        gender: room.gender,
        beds: room.beds,
        occupancy: occupants.length,
        freeBeds: room.beds - occupants.length,
        rankGroup: occupants.length > 0 && poolKey ? (poolKey.split(':')[1] as RankGroup) : null,
        members: [...occupants]
          .sort((a, b) => a.name.localeCompare(b.name, 'he'))
          .map((person) => ({
            userId: person.userId,
            name: person.name,
            teamName: person.teamName,
            sectorName: person.sectorName,
          })),
      };
    })
    .sort(
      (a, b) => a.structureName.localeCompare(b.structureName, 'he') || a.roomName.localeCompare(b.roomName, 'he'),
    );

  // --- זיהוי בעיות והצעות פתרון ---
  const issues: DormIssue[] = [];

  const suggestionsFor = (person: DormParticipant): DormSuggestion[] => {
    const currentRoomId = roomOf.get(person.userId);
    const poolKey = poolKeyOf(person.gender, person.rankGroup);

    return [...occupantsByRoom.entries()]
      .filter(([roomId]) => roomId !== currentRoomId && poolOfRoom.get(roomId) === poolKey)
      .map(([roomId, occupants]) => {
        const room = roomById.get(roomId)!;
        const companions = occupants
          .filter((occupant) => occupant.sectorId != null && occupant.sectorId === person.sectorId)
          .map((occupant) => ({ userId: occupant.userId, name: occupant.name, teamName: occupant.teamName }));
        const free = room.beds - occupants.length;
        return {
          kind: (free > 0 ? 'free_bed' : 'swap_needed') as DormSuggestion['kind'],
          roomId,
          roomLabel: roomLabel(room),
          freeBeds: free,
          companions,
        };
      })
      .filter((suggestion) => suggestion.companions.length > 0)
      .sort(
        (a, b) =>
          Number(b.kind === 'free_bed') - Number(a.kind === 'free_bed') ||
          b.companions.length - a.companions.length ||
          a.roomId - b.roomId,
      )
      .slice(0, 5);
  };

  for (const person of unassigned) {
    issues.push({
      userId: person.userId,
      userName: person.name,
      managerId: person.managerId,
      kind: 'unassigned',
      message: `לא נותרה מיטה פנויה עבור ${person.name} (${person.gender === 'male' ? 'בנים' : 'בנות'}). נדרשת תוספת מבנה או חדר.`,
      suggestions: suggestionsFor(person),
    });
  }

  let withPreferences = 0;
  let preferencesSatisfied = 0;
  let mutualPairsHonored = 0;
  const countedMutual = new Set<string>();

  /**
   * העדפות שניתן בכלל לספק: האדם נרשם לפעימה, ושייך לאותו מאגר (מין + דרגה).
   * העדפה שחוצה מין או דרגה נחסמת כבר בהרשמה, ולכן אינה נחשבת כאן לכשל שיבוץ.
   */
  const satisfiablePreferences = (person: DormParticipant): number[] =>
    person.preferences.filter((id) => {
      const other = byId.get(id);
      return other != null && other.gender === person.gender && other.rankGroup === person.rankGroup;
    });

  for (const person of people) {
    const validPreferences = satisfiablePreferences(person);
    const currentRoomId = roomOf.get(person.userId);
    if (currentRoomId == null) continue; // כבר דווח כ'לא שובץ'

    const roommates = (occupantsByRoom.get(currentRoomId) ?? []).filter(
      (occupant) => occupant.userId !== person.userId,
    );

    for (const roommate of roommates) {
      if (person.preferences.includes(roommate.userId) && roommate.preferences.includes(person.userId)) {
        const key = [person.userId, roommate.userId].sort((a, b) => a - b).join('-');
        if (!countedMutual.has(key)) {
          countedMutual.add(key);
          mutualPairsHonored += 1;
        }
      }
    }

    if (validPreferences.length === 0) continue;
    withPreferences += 1;

    const satisfied = roommates.some((roommate) => validPreferences.includes(roommate.userId));
    if (satisfied) {
      preferencesSatisfied += 1;
      continue;
    }

    const room = roomById.get(currentRoomId)!;
    const names = validPreferences.map((id) => byId.get(id)!.name).join(', ');
    issues.push({
      userId: person.userId,
      userName: person.name,
      managerId: person.managerId,
      kind: 'no_preference_met',
      message: `${person.name} שובץ ל${roomLabel(room)} ללא אף אחת מההעדפות שלו (${names}). נדרש סידור חלופי עם אנשים מאותו מדור.`,
      suggestions: suggestionsFor(person),
    });
  }

  const placements = [...roomOf.entries()].map(([userId, roomId]) => ({ userId, roomId }));

  return {
    placements,
    rooms: roomSummaries,
    issues: issues.sort((a, b) => a.kind.localeCompare(b.kind) || a.userId - b.userId),
    stats: {
      participants: people.length,
      placed: placements.length,
      unassigned: unassigned.length,
      withPreferences,
      preferencesSatisfied,
      mutualPairsHonored,
      totalBeds: rooms.reduce((sum, room) => sum + room.beds, 0),
    },
  };
}

// --- תוכנית לינה מוקדמת: כמה חדרים ובאיזה גודל צריך להזמין ---------------

/** טווח גדלי החדרים שהאופרטיבי יכול להזמין מהספק. */
export const MIN_ROOM_BEDS = 4;
export const MAX_ROOM_BEDS = 8;

export interface DormPlanRoom {
  /** מזהה זמני - שלילי, כדי שלא יתנגש עם מזהי חדרים אמיתיים במסד. */
  roomId: number;
  gender: Gender;
  rankGroup: RankGroup;
  /** גודל החדר המומלץ להזמנה - הקטן ביותר בטווח 4-8 שמכיל את כל הדיירים. */
  size: number;
  occupants: Array<{ userId: number; name: string }>;
}

export interface DormPlanSizeCount {
  gender: Gender;
  size: number;
  count: number;
}

export interface DormPlan {
  rooms: DormPlanRoom[];
  /** סיכום לפי מין וגודל - זה מה שהאופרטיבי מעביר הלאה לספק. */
  sizeCounts: DormPlanSizeCount[];
  totalRooms: number;
  totalPeople: number;
  /** אמור תמיד להיות 0 - המאגר הסינתטי גדול מספיק בכוונה; נשמר להגנה. */
  unassigned: number;
}

/**
 * תוכנית לינה מוקדמת, לפני שיש חדרים אמיתיים במערכת: אחרי שהמפקדים בחרו מי
 * נוסע, מריצים את אותו מנוע השיבוץ (allocateDorms) מול מאגר חדרים סינתטי
 * וגדול מספיק בגודל MAX_ROOM_BEDS - כך המנוע מקבץ אנשים לחדרים בדיוק כמו
 * בשיבוץ אמיתי (מכבד העדפות שותפים, לא מערבב מין/דרג). אחר כך, לכל חדר
 * שאוכלס, הגודל *המדווח* הוא תמיד MAX_ROOM_BEDS (8) - ההעדפה היא למקסם
 * תפוסת חדרים גדולים במקום לפזר אנשים בהרבה חדרים קטנים, גם אם חדר מסוים
 * מאוכלס בפועל בפחות אנשים מהמקסימום. התוצאה היא הצעה - האופרטיבי מזמין
 * לפי זה, ואז יוצר את החדרים האמיתיים כשהם ידועים (ראו GET /:id/dorms/plan
 * ב-dorms.routes.ts).
 */
export function planDormRooms(participants: readonly DormParticipant[]): DormPlan {
  const byGender = new Map<Gender, number>();
  for (const person of participants) {
    byGender.set(person.gender, (byGender.get(person.gender) ?? 0) + 1);
  }

  let nextRoomId = -1;
  const syntheticRooms: DormRoom[] = [];
  for (const [gender, count] of byGender) {
    // מלאי גדול בכוונה: מספיק חדרים בגודל המקסימלי כדי לכסות את כולם גם
    // אילו כל חדר היה מתמלא רק במינימום - כך לעולם לא נשארים בלי מקום.
    const roomsNeeded = Math.ceil(count / MIN_ROOM_BEDS);
    const genderLabel = gender === 'male' ? 'בנים' : 'בנות';
    for (let index = 0; index < roomsNeeded; index += 1) {
      syntheticRooms.push({
        roomId: nextRoomId,
        roomName: `חדר מתוכנן ${index + 1}`,
        structureId: gender === 'male' ? -1 : -2,
        structureName: `מבנה ${genderLabel} (מתוכנן)`,
        gender,
        beds: MAX_ROOM_BEDS,
      });
      nextRoomId -= 1;
    }
  }

  const result = allocateDorms(participants, syntheticRooms);

  const rooms: DormPlanRoom[] = result.rooms
    .filter((room) => room.occupancy > 0)
    .map((room) => ({
      roomId: room.roomId,
      gender: room.gender,
      rankGroup: room.rankGroup!,
      // תמיד מומלץ בגודל המקסימלי - ראו ההסבר למעלה.
      size: MAX_ROOM_BEDS,
      occupants: room.members.map((member) => ({ userId: member.userId, name: member.name })),
    }));

  const sizeCountMap = new Map<string, DormPlanSizeCount>();
  for (const room of rooms) {
    const key = `${room.gender}:${room.size}`;
    const entry = sizeCountMap.get(key) ?? { gender: room.gender, size: room.size, count: 0 };
    entry.count += 1;
    sizeCountMap.set(key, entry);
  }
  const sizeCounts = [...sizeCountMap.values()].sort(
    (a, b) => a.gender.localeCompare(b.gender) || b.size - a.size,
  );

  return {
    rooms,
    sizeCounts,
    totalRooms: rooms.length,
    totalPeople: participants.length,
    unassigned: result.stats.unassigned,
  };
}

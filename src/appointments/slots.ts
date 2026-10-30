// The mock calendar, as plain code. No model is involved in working out dates, because
// models are unreliable at calendars and this needs no intelligence.

const SLOT_TIMES = ['09:00', '10:30', '13:00', '15:30'];
const BUSINESS_DAYS_AHEAD = 10;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export type Slot = { slot: string; spoken: string };
export type SlotPreference = { day?: unknown; time_of_day?: unknown };

function toSlot(date: Date, time: string): Slot {
  const [hour, minute] = time.split(':').map(Number);
  const clock = `${hour > 12 ? hour - 12 : hour}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
  const spoken = `${WEEKDAYS[date.getUTCDay()]}, ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()} at ${clock}`;
  return { slot: `${date.toISOString().slice(0, 10)}T${time}`, spoken };
}

// Every slot on the calendar, in order, starting tomorrow.
export function allSlots(now = new Date()): Slot[] {
  const slots: Slot[] = [];
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (let businessDays = 0; businessDays < BUSINESS_DAYS_AHEAD; ) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    businessDays++;
    for (const time of SLOT_TIMES) slots.push(toSlot(date, time));
  }
  return slots;
}

export function matchesPreference({ slot, spoken }: Slot, preference: SlotPreference): boolean {
  const hour = Number(slot.slice(11, 13));
  if (preference.time_of_day === 'morning' && hour >= 12) return false;
  if (preference.time_of_day === 'afternoon' && hour < 12) return false;
  if (typeof preference.day === 'string' && !spoken.startsWith(preference.day)) return false;
  return true;
}

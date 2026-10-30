"use strict";

// The Tanakōdeyam calendar's date arithmetic, ported from the calendar page
// (public/calendar/index.html) so the server can turn a civil day number
// (days since 1970-01-01 UTC, how notes are keyed) into a calendar date.
// Keep the constants and buildYear() in step with that page.

const TROPICAL_YEAR = 365.2422;
const SYNODIC_MONTH = 29.530588853;
const MS_PER_DAY = 86400000;

// JavaScript treats years 0-99 specially in Date.UTC; this avoids that.
function makeUTCDate(year, month, day) {
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(year, month - 1, day);
    return date.getTime();
}

// Winter solstice at the beginning of calendar year 1, and the reference new moon.
const EPOCH_SOLSTICE = makeUTCDate(1, 12, 20);
const NEW_MOON_EPOCH = makeUTCDate(1, 12, 20);

const MONTHS = [
    "Hiūnmoin 虚月",
    "Wānmoin 一月",
    "Dhuōmoin 二月",
    "Sānemoin 三月",
    "Nōlmoin 四月",
    "Peiksemoin 五月",
    "Liāmoin 六月",
    "Newōsēpreya 不見神",
    "Khīnmoin 七月",
    "Okotōmoin 八月",
    "Kokonōmoin 九月",
    "Thēsemoin 十月",
    "Thōnamoin 十一月",
    "Elendāmoin 十二月"
];

// Indexes of the intercalary periods in MONTHS.
const INTERCALARY = new Set([0, 7]);

// English names for the twelve regular months (the sinographs in their native
// names are the numerals 一月 ... 十二月). The two intercalary periods have no
// English name; they keep their native ones.
const ORDINALS = [
    "First", "Second", "Third", "Fourth", "Fifth", "Sixth",
    "Seventh", "Eighth", "Ninth", "Tenth", "Eleventh", "Twelfth"
];

function englishMonthName(index) {
    if (INTERCALARY.has(index)) {
        return null;
    }
    // Months 1-6 are indexes 1-6; months 7-12 are indexes 8-13.
    const number = index < 7 ? index : index - 1;
    return `${ORDINALS[number - 1]} month`;
}

// The native name without its sinographs: "Hiūnmoin 虚月" -> "Hiūnmoin".
function nativeMonthName(index) {
    return MONTHS[index].replace(/\s*[\u3000-\u9fff\uf900-\ufaff]+$/, "");
}

function winterSolstice(year) {
    return EPOCH_SOLSTICE + (year - 1) * TROPICAL_YEAR * MS_PER_DAY;
}

function summerSolstice(year) {
    return winterSolstice(year) + (TROPICAL_YEAR / 2) * MS_PER_DAY;
}

// First mean new moon strictly after an instant.
function nextNewMoon(instant) {
    const elapsed = (instant - NEW_MOON_EPOCH) / MS_PER_DAY;
    const n = Math.floor(elapsed / SYNODIC_MONTH) + 1;
    return NEW_MOON_EPOCH + n * SYNODIC_MONTH * MS_PER_DAY;
}

// The year's 14 months as half-open [start, end) intervals of instants.
function buildYear(year) {
    const winter = winterSolstice(year);
    const summer = summerSolstice(year);
    const nextWinter = winterSolstice(year + 1);
    const months = [];

    // First intercalary period: winter solstice to the first new moon after it.
    let start = winter;
    let newMoon = nextNewMoon(winter);
    months.push({ index: 0, start, end: newMoon });

    // Months 1-6; month 6 is cut off at the summer solstice.
    start = newMoon;
    for (let i = 1; i <= 6; i++) {
        const end = i === 6 ? summer : start + SYNODIC_MONTH * MS_PER_DAY;
        months.push({ index: i, start, end });
        start = end;
    }

    // Second intercalary period: summer solstice to the first new moon after it.
    newMoon = nextNewMoon(summer);
    months.push({ index: 7, start: summer, end: newMoon });

    // Months 8-13; month 13 is cut off at the next winter solstice.
    start = newMoon;
    for (let i = 8; i <= 13; i++) {
        const end = i === 13 ? nextWinter : start + SYNODIC_MONTH * MS_PER_DAY;
        months.push({ index: i, start, end });
        start = end;
    }

    return months;
}

// Calendar intervals are half-open: a civil day belongs to the interval if
// its UTC day begins at or after the start and before the end.
function firstCivilDay(instant) {
    return Math.ceil(instant / MS_PER_DAY);
}

function lastCivilDay(instant) {
    return Math.ceil(instant / MS_PER_DAY) - 1;
}

// First and last civil day of a universal year (inclusive).
function yearDayRange(year) {
    return {
        first: firstCivilDay(winterSolstice(year)),
        last: lastCivilDay(winterSolstice(year + 1))
    };
}

function formatGregorian(dayNumber) {
    const d = new Date(dayNumber * MS_PER_DAY);
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

// The universal year containing a civil day, or null before year 1.
function yearOfDay(dayNumber) {
    let year = Math.floor((dayNumber * MS_PER_DAY - EPOCH_SOLSTICE) / (TROPICAL_YEAR * MS_PER_DAY)) + 1;

    // The estimate can be off by one near a solstice.
    while (year > 1 && firstCivilDay(winterSolstice(year)) > dayNumber) {
        year--;
    }
    while (firstCivilDay(winterSolstice(year + 1)) <= dayNumber) {
        year++;
    }

    return year >= 1 && firstCivilDay(winterSolstice(year)) <= dayNumber ? year : null;
}

const yearCache = new Map();

function monthsOfYear(year) {
    if (!yearCache.has(year)) {
        if (yearCache.size > 200) {
            yearCache.clear();
        }
        yearCache.set(
            year,
            buildYear(year).map((m) => ({
                ...m,
                first: firstCivilDay(m.start),
                last: lastCivilDay(m.end)
            }))
        );
    }
    return yearCache.get(year);
}

// Civil day number -> { year, monthIndex, monthName, dayInMonth, intercalary, gregorian },
// or null for days before year 1.
function describeDay(dayNumber) {
    const year = yearOfDay(dayNumber);

    if (year === null) {
        return null;
    }

    const month = monthsOfYear(year).find((m) => m.first <= dayNumber && dayNumber <= m.last);

    if (!month) {
        return null;
    }

    const intercalary = INTERCALARY.has(month.index);

    return {
        year,
        monthIndex: month.index,
        monthName: MONTHS[month.index],
        // For display outside the calendar: English for the regular months,
        // the native name (no sinographs) for the intercalary periods.
        monthLabel: englishMonthName(month.index) || nativeMonthName(month.index),
        monthIsNative: intercalary,
        dayInMonth: dayNumber - month.first + 1,
        intercalary,
        gregorian: formatGregorian(dayNumber)
    };
}

module.exports = { MONTHS, yearDayRange, describeDay, yearOfDay, formatGregorian };

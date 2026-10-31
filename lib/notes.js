"use strict";

// Shared shape for calendar notes shown on lore pages (era pages and books):
// notes grouped by the universal year they fall in, in date order.

const calendar = require("./calendar");

// `rows` are notes ordered by day ({ id, day, title, body, book_id, book_title,
// book_slug, book_category_slug }). `labelFor(year)` returns { label, eraYear? }
// for a year heading. Years without notes simply don't appear.
function groupNotes(rows, labelFor) {
    const groups = [];

    for (const row of rows) {
        const date = calendar.describeDay(row.day);

        if (!date) {
            continue;
        }

        let group = groups[groups.length - 1];
        if (!group || group.year !== date.year) {
            group = { year: date.year, ...labelFor(date.year), notes: [] };
            groups.push(group);
        }

        group.notes.push({
            id: row.id,
            day: row.day,
            title: row.title,
            body: row.body,
            monthName: date.monthName,
            monthLabel: date.monthLabel,
            monthIsNative: date.monthIsNative,
            dayInMonth: date.dayInMonth,
            intercalary: date.intercalary,
            gregorian: date.gregorian,
            book: row.book_id
                ? {
                      id: row.book_id,
                      title: row.book_title,
                      url: `/lore/${encodeURIComponent(row.book_category_slug)}/${encodeURIComponent(row.book_slug)}`
                  }
                : null
        });
    }

    return groups;
}

// The columns groupNotes expects, for a query on `notes n`.
const NOTE_COLUMNS = `n.id, n.day, n.title, n.body, n.book_id,
    p.title AS book_title, p.slug AS book_slug, c.slug AS book_category_slug`;

const NOTE_JOINS = `LEFT JOIN lore_pages p ON p.id = n.book_id
    LEFT JOIN lore_categories c ON c.id = p.category_id`;

// Link to a note in the calendar: opens its year, then its day with the note
// highlighted. Without a note it only opens the year.
function calendarUrl(year, note) {
    if (!year) {
        return "/calendar/";
    }

    return note
        ? `/calendar/?year=${year}&day=${note.day}&note=${note.id}`
        : `/calendar/?year=${year}`;
}

module.exports = { calendarUrl, groupNotes, NOTE_COLUMNS, NOTE_JOINS };

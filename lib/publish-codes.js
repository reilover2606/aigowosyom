"use strict";

// Shared by server.js (the supervisor) and lib/publish.js.
// RESTART_CODE: a public instance has swapped in a new database and wants to start again.
// SETUP_PROBLEM_CODE: the program can't run until something is fixed (don't keep restarting).
module.exports = { RESTART_CODE: 75, SETUP_PROBLEM_CODE: 78 };

// TEMPORARY debug instrumentation for the auth redirect-loop investigation.
// Not part of the permanent architecture — remove once the bug is fixed.
let seq = 0;

function stamp() {
  const t = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  seq += 1;
  return `${t} #${seq}`;
}

export function authLog(...args) {
  console.log(`[AUTH ${stamp()}]`, ...args);
}

export function routeLog(...args) {
  console.log(`[ROUTE ${stamp()}]`, ...args);
}

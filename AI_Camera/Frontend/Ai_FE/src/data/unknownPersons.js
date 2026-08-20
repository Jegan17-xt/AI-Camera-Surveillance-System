const face = (seed) => `https://i.pravatar.cc/150?img=${seed}`;

export const unknownPersons = [
  { id: 1, image: face(60), date: "2026-07-23", time: "08:35 AM", zone: "Loading Dock", detections: 3, lastSeen: "2026-07-23 08:41 AM" },
  { id: 2, image: face(61), date: "2026-07-23", time: "07:41 AM", zone: "Parking Lot 2", detections: 2, lastSeen: "2026-07-23 07:55 AM" },
  { id: 3, image: face(62), date: "2026-07-22", time: "06:12 PM", zone: "Main Gate", detections: 5, lastSeen: "2026-07-23 06:02 AM" },
  { id: 4, image: face(63), date: "2026-07-22", time: "02:20 PM", zone: "Rear Exit", detections: 1, lastSeen: "2026-07-22 02:20 PM" },
  { id: 5, image: face(64), date: "2026-07-21", time: "11:05 AM", zone: "Lobby", detections: 4, lastSeen: "2026-07-22 09:14 AM" },
  { id: 6, image: face(65), date: "2026-07-21", time: "09:47 AM", zone: "Main Gate", detections: 2, lastSeen: "2026-07-21 09:58 AM" },
];

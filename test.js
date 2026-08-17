#!/usr/bin/env node
// End-to-end API test for Carpool App
// Usage: node test.js

const BASE = 'http://localhost:3000';
const assert = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); };

async function post(path, body, cookieJar) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookieJar ? { Cookie: cookieJar } : {}) },
    body: JSON.stringify(body),
    redirect: 'manual'
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const match = setCookie.match(/connect\.sid=[^;]+/);
    if (match) cookieJar = match[0];
  }
  return { status: res.status, data: await res.json(), cookie: cookieJar };
}

async function get(path, cookieJar) {
  const res = await fetch(BASE + path, {
    headers: cookieJar ? { Cookie: cookieJar } : {},
    redirect: 'manual'
  });
  return { status: res.status, data: await res.json() };
}

async function main() {
  console.log('🚗 Carpool E2E Test\n');

  let ca, cb; // cookie jars

  // ── 1. Register ──
  console.log('1. Register alice + bob...');
  let r = await post('/api/register', { username: 'alice', email: 'alice@test.com', password: 'pass123' });
  assert(r.status === 200, 'register alice');
  ca = r.cookie;
  assert(r.data.user.username === 'alice', 'alice username');

  r = await post('/api/register', { username: 'bob', email: 'bob@test.com', password: 'pass123' });
  assert(r.status === 200, 'register bob');
  cb = r.cookie;
  console.log('   ✅ OK');

  // ── 2. Create carpool ──
  console.log('2. Alice creates carpool...');
  r = await post('/api/carpools', {
    name: 'Work Commute',
    meetup_name: 'Central Park', meetup_lat: 40.785091, meetup_lng: -73.968285,
    destination_name: 'Office', destination_lat: 40.758896, destination_lng: -73.985130
  }, ca);
  assert(r.status === 200, 'create carpool');
  const carpoolId = r.data.carpool.id;
  console.log('   ✅ carpool id:', carpoolId);

  // ── 3. Add bob ──
  console.log('3. Alice adds Bob...');
  r = await post(`/api/carpools/${carpoolId}/members`, { username: 'bob' }, ca);
  assert(r.status === 200, 'add bob');
  console.log('   ✅ OK');

  // ── 4. Bob accepts invitation ──
  console.log('4. Bob accepts invitation...');
  r = await get('/api/invitations', cb);
  assert(r.data.invitations.length === 1, 'invitation exists');
  r = await post(`/api/invitations/${r.data.invitations[0].id}/accept`, {}, cb);
  assert(r.status === 200, 'accept invitation');
  console.log('   ✅ OK');

  // ── 5. Start session ──
  console.log('5. Alice starts session...');
  r = await post(`/api/carpools/${carpoolId}/sessions/start`, {}, ca);
  assert(r.status === 200, 'start session');
  assert(r.data.session.phase === 'meetup', 'phase meetup');
  assert(r.data.session.members.length === 2, '2 members in session');
  console.log('   ✅ OK');

  // ── 5b. Alice claims driving ──
  console.log('5b. Alice claims driving...');
  r = await post(`/api/carpools/${carpoolId}/sessions/respond`, { status: 'driving' }, ca);
  assert(r.status === 200, 'alice driving');
  assert(r.data.session.driver_id === 1, 'alice is driver');
  console.log('   ✅ OK');

  // ── 6. Bob responds riding ──
  console.log('6. Bob responds riding...');
  r = await post(`/api/carpools/${carpoolId}/sessions/respond`, { status: 'riding' }, cb);
  assert(r.status === 200, 'bob riding');
  const bobMember = r.data.session.members.find(m => m.user_id === 2);
  assert(bobMember.status === 'riding', 'bob status riding');
  console.log('   ✅ OK');

  // ── 7. Advance: pickup → destination ──
  console.log('7. Advance: pickup → destination...');
  r = await post(`/api/carpools/${carpoolId}/sessions/advance-phase`, { phase: 'destination' }, ca);
  assert(r.status === 200, 'advance destination');
  assert(r.data.session.phase === 'destination', 'phase destination');
  console.log('   ✅ OK');

  // ── 8. Check coins ──
  console.log('8. Check coins distributed...');
  r = await get(`/api/carpools/${carpoolId}`, ca);
  const aliceMember = r.data.members.find(m => m.id === 1);
  const bobMember2 = r.data.members.find(m => m.id === 2);
  assert(aliceMember.coins_balance === 1, 'alice +1 coins');
  assert(bobMember2.coins_balance === -1, 'bob -1 coins');
  assert(r.data.history.length === 1, '1 history entry');
  assert(r.data.history[0].mileage > 0, 'mileage recorded');
  console.log('   ✅ alice: +1, bob: -1, mileage:', r.data.history[0].mileage.toFixed(2), 'km');

  // ── 9. Advance: destination → completed (no return leg) ──
  console.log('9. Advance: destination → completed (no return leg)...');
  r = await post(`/api/carpools/${carpoolId}/sessions/advance-phase`, { phase: 'completed' }, ca);
  assert(r.status === 200, 'advance completed from destination');
  assert(r.data.session.phase === 'completed', 'phase completed');
  assert(r.data.session.ended_at !== null, 'ended_at set');
  console.log('   ✅ OK');

  // ── 10. Verify final state ──
  console.log('10. Verify final state...');
  r = await get(`/api/carpools/${carpoolId}`, ca);
  assert(r.data.activeSession === null, 'no active session');
  assert(r.data.history.length === 2, '2 history entries');
  console.log('   ✅ history entries:', r.data.history.length);

  // ── 11. Invalid transitions ──
  console.log('11. Test invalid transitions...');
  // Start new session
  await post(`/api/carpools/${carpoolId}/sessions/start`, {}, ca);
  // Try invalid: pickup → dropoff/return (should fail)
  r = await post(`/api/carpools/${carpoolId}/sessions/advance-phase`, { phase: 'back_to_meetup' }, ca);
  assert(r.status === 400, 'invalid transition rejected');
  // Advance to destination, then try invalid: destination → return (should fail)
  r = await post(`/api/carpools/${carpoolId}/sessions/advance-phase`, { phase: 'destination' }, ca);
  assert(r.status === 200, 'advance to destination');
  r = await post(`/api/carpools/${carpoolId}/sessions/advance-phase`, { phase: 'back_to_meetup' }, ca);
  assert(r.status === 400, 'return leg rejected');
  console.log('   ✅ invalid transitions correctly rejected');
  // Cancel the test session
  await post(`/api/carpools/${carpoolId}/sessions/cancel`, {}, ca);

  // ── 12. Cancel session test ──
  console.log('12. Test cancel session...');
  await post(`/api/carpools/${carpoolId}/sessions/start`, {}, ca);
  r = await post(`/api/carpools/${carpoolId}/sessions/cancel`, {}, ca);
  assert(r.status === 200, 'cancel session');
  r = await get(`/api/carpools/${carpoolId}`, ca);
  assert(r.data.activeSession === null, 'no active session after cancel');
  console.log('   ✅ cancel works');

  // ── 13. Auto-complete: arriving at the destination ends the trip ──
  console.log('13. Auto-complete on arrival at destination (no return leg)...');
  await post(`/api/carpools/${carpoolId}/sessions/start`, {}, ca);
  r = await post(`/api/carpools/${carpoolId}/sessions/respond`, { status: 'driving' }, ca);
  assert(r.status === 200, 'alice driving');
  r = await post(`/api/carpools/${carpoolId}/sessions/respond`, { status: 'riding' }, cb);
  assert(r.status === 200, 'bob riding');
  r = await post(`/api/carpools/${carpoolId}/sessions/advance-phase`, { phase: 'destination' }, ca);
  assert(r.status === 200 && r.data.session.phase === 'destination', 'en route to destination');
  // One arrival at the destination marks the whole group (same car) and auto-completes
  r = await post(`/api/carpools/${carpoolId}/sessions/respond`, { status: 'arrived' }, ca);
  assert(r.status === 200, 'arrive at destination');
  assert(r.data.session.phase === 'completed', 'trip auto-completed at destination');
  console.log('   ✅ trip ended at the destination');

  console.log('\n🎉 All tests passed!');
}

main().catch(err => {
  console.error('\n❌', err.message);
  process.exit(1);
});

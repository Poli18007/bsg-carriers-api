// Seed a full set of DEMO data to exercise every feature. Everything is tagged
// '[DEMO]' (in a notes/remarks field, or a *.test email) so it can be removed in
// one pass; the real load 10212 and the real admin account are never touched.
//
//   DATABASE_URL=… node scripts/seed-testdata.mjs          # clean demo + reseed
//   DATABASE_URL=… node scripts/seed-testdata.mjs --clean  # just remove demo
//
// The owner-op login for testing the portal is printed at the end.

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1); }
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false } });
await client.connect();
const q = (sql, params = []) => client.query(sql, params);
const one = async (sql, params = []) => (await q(sql, params)).rows[0];
const CLEAN_ONLY = process.argv.includes('--clean');

// --- clean any previous demo data (child-first for FKs) ---------------------
console.log('Removing previous [DEMO] data…');
await q("DELETE FROM invoices WHERE notes LIKE '%[DEMO]%'");
await q("DELETE FROM dvir_reports WHERE remarks LIKE '%[DEMO]%'");
await q("DELETE FROM expenses WHERE description LIKE '%[DEMO]%'");
await q("DELETE FROM maintenance_records WHERE description LIKE '%[DEMO]%'");
await q("DELETE FROM loads WHERE notes LIKE '%[DEMO]%'");
await q("DELETE FROM trips WHERE notes LIKE '%[DEMO]%'");
await q("DELETE FROM trucks WHERE notes LIKE '%[DEMO]%'");
await q("DELETE FROM trailers WHERE notes LIKE '%[DEMO]%'");
await q("DELETE FROM customers WHERE notes LIKE '%[DEMO]%'");
await q("DELETE FROM brokers WHERE notes LIKE '%[DEMO]%'");
await q("DELETE FROM carriers WHERE staff_notes LIKE '%[DEMO]%'");
await q("DELETE FROM staff_users WHERE email LIKE '%@bsg.test'");
if (CLEAN_ONLY) { console.log('Done (clean only).'); await client.end(); process.exit(0); }

const D = '[DEMO]';
const colId = async (kind, name) => (await one("SELECT bc.id FROM board_columns bc JOIN boards b ON b.id=bc.board_id AND b.kind=$1 WHERE bc.name=$2 LIMIT 1", [kind, name]) || {}).id;
const labelId = async (name) => (await one('SELECT id FROM labels WHERE name=$1', [name]) || {}).id;

// --- staff (a manager + a dispatcher, known passwords) ----------------------
const staffHash = await bcrypt.hash('Password2026!', 12);
const mgr = await one("INSERT INTO staff_users (email,name,password_hash,role) VALUES ('manager@bsg.test','Morgan Lee',$1,'manager') RETURNING id", [staffHash]);
const disp = await one("INSERT INTO staff_users (email,name,password_hash,role) VALUES ('dispatcher@bsg.test','Dev Singh',$1,'dispatcher') RETURNING id", [staffHash]);
const admin = await one("SELECT id FROM staff_users WHERE role='admin' ORDER BY id LIMIT 1");
const dispatchers = [admin?.id, mgr.id, disp.id].filter(Boolean);

// --- customers --------------------------------------------------------------
const CUSTOMERS = [
  ['Exemplis LLC', 'Cindy Ortega', 'Ontario', 'CA'], ['Global Furniture Co', 'Rob Dean', 'High Point', 'NC'],
  ['Pacific Foods', 'Marie Chen', 'Tualatin', 'OR'], ['Sierra Beverage', 'Tom Ray', 'Sacramento', 'CA'],
  ['Summit Retail', 'Alicia Gomez', 'Denver', 'CO'],
];
const custIds = [];
for (const [name, contact, city, st] of CUSTOMERS)
  custIds.push((await one('INSERT INTO customers (name,contact_name,city,state,notes) VALUES ($1,$2,$3,$4,$5) RETURNING id', [name, contact, city, st, D])).id);

// --- brokers ----------------------------------------------------------------
const BROKERS = [['TQL', 'MC-123456'], ['Coyote Logistics', 'MC-234567'], ['RXO', 'MC-345678'], ['Echo Global', 'MC-456789']];
const brokerIds = [];
for (const [name, mc] of BROKERS)
  brokerIds.push((await one('INSERT INTO brokers (name,mc_number,notes) VALUES ($1,$2,$3) RETURNING id', [name, mc, D])).id);

// --- carriers (owner-ops) ---------------------------------------------------
const OO_PASS = 'OwnerOp2026!';
const ooHash = await bcrypt.hash(OO_PASS, 12);
const CARRIERS = [
  // login one first
  { email: 'ownerop@bsgcarriers.test', company: 'Akal Transport LLC', contact: 'Harjinder Akal', mc: 'MC-778812', dot: 'DOT-2211345', equip: 'Dry Van, Reefer', status: 'approved', fee: 5, hash: ooHash },
  { email: 'klf@bsgcarriers.test', company: 'KLF Trucking Inc', contact: 'Karan Fields', mc: 'MC-556743', dot: 'DOT-1902233', equip: 'Dry Van', status: 'approved', fee: 6 },
  { email: 'rivera@bsgcarriers.test', company: 'Rivera Logistics', contact: 'Marco Rivera', mc: 'MC-661220', dot: 'DOT-3341902', equip: 'Reefer', status: 'approved', fee: 5 },
  { email: 'sandhu@bsgcarriers.test', company: 'Sandhu Carriers', contact: 'Gurpreet Sandhu', mc: 'MC-903471', dot: 'DOT-2277431', equip: 'Flatbed', status: 'approved', fee: 7 },
  { email: 'golden@bsgcarriers.test', company: 'Golden State Hauling', contact: 'Ed Park', mc: 'MC-112900', dot: 'DOT-8890021', equip: 'Dry Van', status: 'pending', fee: 0 },
];
const carrierIds = [];
for (const c of CARRIERS) {
  const hash = c.hash || await bcrypt.hash('Carrier2026!', 12);
  const row = await one(
    `INSERT INTO carriers (email,password_hash,company_name,contact_name,mc_number,dot_number,equipment,status,dispatch_fee_pct,staff_notes,phone)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [c.email, hash, c.company, c.contact, c.mc, c.dot, c.equip, c.status, c.fee, D, '555-01' + (carrierIds.length + 10)]);
  carrierIds.push(row.id);
}

// --- drivers (2 per approved carrier) ---------------------------------------
const DRIVER_NAMES = [['Baljit S.', 'Manpreet K.'], ['Cody R.', 'Luis M.'], ['Ahmed N.', 'Victor P.'], ['Ravi D.', 'Sam T.'], ['Nick B.']];
const driverIds = []; // flat, with carrier index tracked
const driversByCarrier = {};
for (let i = 0; i < carrierIds.length; i++) {
  driversByCarrier[i] = [];
  for (const nm of (DRIVER_NAMES[i] || [])) {
    const dr = await one('INSERT INTO drivers (carrier_id,name,phone,cdl_number,cdl_state) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [carrierIds[i], nm, '555-77' + driverIds.length, 'CDL' + (10000 + driverIds.length), 'CA']);
    driverIds.push(dr.id); driversByCarrier[i].push(dr.id);
  }
}

// --- trucks -----------------------------------------------------------------
const TRUCKS = [['KLF-101', 0], ['KLF-102', 1], ['KLF-103', 2], ['KLF-104', 3], ['KLF-105', 0], ['KLF-106', 1]];
const truckIds = [];
for (const [num, ci] of TRUCKS) {
  const dr = (driversByCarrier[ci] || [])[0] || null;
  truckIds.push((await one('INSERT INTO trucks (number,carrier_id,driver_id,make_model,in_service,notes) VALUES ($1,$2,$3,$4,true,$5) RETURNING id',
    [num, carrierIds[ci], dr, ['Freightliner Cascadia', 'Kenworth T680', 'Volvo VNL', 'Peterbilt 579'][truckIds.length % 4], D])).id);
}

// --- trailers (across the trailers board) -----------------------------------
const trCols = ['In Transit', 'Owner Op', 'Lodi Yard', 'Akal Yard', 'San Diego', 'Buena Park'];
const TRAILERS = [
  ['53001', 'Dry Van', 'loaded'], ['53002', 'Reefer', 'empty'], ['53003', 'Dry Van', 'loaded'], ['53004', 'Flatbed', 'empty'],
  ['53005', 'Reefer', 'damaged'], ['53006', 'Dry Van', 'maintenance'], ['53007', 'Dry Van', 'empty'], ['53008', 'Reefer', 'loaded'],
  ['53009', 'Dry Van', 'empty'], ['53010', 'Flatbed', 'loaded'],
];
for (let i = 0; i < TRAILERS.length; i++) {
  const [num, type, state] = TRAILERS[i];
  await q('INSERT INTO trailers (number,type,state,carrier_id,column_id,notes) VALUES ($1,$2,$3,$4,$5,$6)',
    [num, type, state, carrierIds[i % 4], await colId('trailers', trCols[i % trCols.length]), D]);
}
const trailerRows = (await q("SELECT id FROM trailers WHERE notes=$1 ORDER BY id", [D])).rows.map(r => r.id);

// --- loads ------------------------------------------------------------------
const LABELS = ['KLF Truck', 'Owner Op', 'Exemplis OB', 'Backhaul', 'CA Local', 'Other CA OB'];
const COLS = ['Tendered', 'Ready', 'Assigned', 'Akal Yard', 'In Transit', 'Delivered'];
const LANES = [
  ['Ontario', 'CA', 'Denver', 'CO', 1015], ['San Diego', 'CA', 'Roseville', 'MN', 1960], ['Sacramento', 'CA', 'Phoenix', 'AZ', 755],
  ['Ontario', 'CA', 'Dallas', 'TX', 1440], ['Fresno', 'CA', 'Seattle', 'WA', 960], ['Los Angeles', 'CA', 'Chicago', 'IL', 2015],
  ['Stockton', 'CA', 'Portland', 'OR', 620], ['Buena Park', 'CA', 'Reno', 'NV', 480], ['Lodi', 'CA', 'Salt Lake City', 'UT', 660],
  ['San Diego', 'CA', 'Denver', 'CO', 1090],
];
const loadIds = [];
for (let i = 0; i < 16; i++) {
  const lane = LANES[i % LANES.length];
  const ci = i % 4;
  const col = COLS[i % COLS.length];
  const rate = 1800 + (i * 137) % 3600;
  const row = await one(
    `INSERT INTO loads (ref,customer_id,carrier_id,driver_id,truck_id,trailer_id,dispatcher_id,label_id,column_id,
       origin,destination,pickup_name,pickup_city,pickup_state,pickup_appt,delivery_city,delivery_state,delivery_appt,
       commodity,weight,equipment,rate,miles,pu_number,status,notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,'booked',$25) RETURNING id`,
    ['D-' + (2400 + i), custIds[i % custIds.length], carrierIds[ci], (driversByCarrier[ci] || [])[0] || null,
     truckIds[i % truckIds.length], trailerRows[i % trailerRows.length], dispatchers[i % dispatchers.length],
     await labelId(LABELS[i % LABELS.length]), await colId('loads', col),
     lane[0] + ', ' + lane[1], lane[2] + ', ' + lane[3], CUSTOMERS[i % CUSTOMERS.length][0] + ' DC', lane[0], lane[1],
     'Sep ' + (2 + i % 20) + ' 08:00-12:00', lane[2], lane[3], 'Sep ' + (4 + i % 20) + ' 07:00',
     ['Palletized goods', 'Furniture', 'Frozen food', 'Beverages', 'Retail mixed'][i % 5], (22000 + i * 400) + ' lbs',
     ['Dry Van', 'Reefer', 'Flatbed'][i % 3], rate, lane[4], 'PU' + (10000 + i), D]);
  loadIds.push(row.id);
  // a couple of check-calls + an accessorial on some loads
  await q("INSERT INTO load_events (load_id,staff_email,kind,body) VALUES ($1,'demo@bsg.test','check_call',$2)", [row.id, 'Driver dispatched, ETA to pickup on time.']);
  if (i % 3 === 0) await q("INSERT INTO load_events (load_id,staff_email,kind,body) VALUES ($1,'demo@bsg.test','check_call','At pickup, loaded and rolling.')", [row.id]);
  if (i % 4 === 0) await q("INSERT INTO load_accessorials (load_id,kind,amount,notes) VALUES ($1,'detention',150,'2 hrs at pickup')", [row.id]);
}

// --- trips (group a few loads per truck) ------------------------------------
async function trip(seq, name, truckIdx, ci, status, loadIdxs) {
  const t = await one('INSERT INTO trips (seq,name,truck_id,driver_id,carrier_id,status,start_date,notes) VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,$7) RETURNING id',
    [seq, name, truckIds[truckIdx], (driversByCarrier[ci] || [])[0] || null, carrierIds[ci], status, D]);
  let s = 1; for (const li of loadIdxs) { await q('UPDATE loads SET trip_id=$1, stop_seq=$2 WHERE id=$3', [t.id, s++, loadIds[li]]); }
  return t.id;
}
await trip(101, 'CA → CO run', 0, 0, 'in_transit', [0, 9]);
await trip(102, 'Exemplis OB sweep', 1, 1, 'planned', [1, 7]);
await trip(103, 'Southwest loop', 2, 2, 'completed', [2, 5]);

// --- invoices ---------------------------------------------------------------
async function invoice(seq, carrierIdx, status, lineLoadIdxs, feePct, payAmount) {
  const inv = await one("INSERT INTO invoices (seq,carrier_id,bill_to,status,issue_date,notes) VALUES ($1,$2,$3,$4,CURRENT_DATE,$5) RETURNING id",
    [seq, carrierIds[carrierIdx], CARRIERS[carrierIdx].company, status, 'Net 15 ' + D]);
  for (const li of lineLoadIdxs) {
    const l = await one('SELECT ref,rate,origin,destination FROM loads WHERE id=$1', [loadIds[li]]);
    const amt = Math.round((Number(l.rate) || 0) * feePct) / 100;
    await q('INSERT INTO invoice_lines (invoice_id,load_id,description,amount) VALUES ($1,$2,$3,$4)',
      [inv.id, loadIds[li], `Dispatch fee ${feePct}% — load ${l.ref} (${l.origin} → ${l.destination})`, amt]);
  }
  if (payAmount) await q("INSERT INTO invoice_payments (invoice_id,amount,method,paid_at) VALUES ($1,$2,'ACH',CURRENT_DATE)", [inv.id, payAmount]);
  return inv.id;
}
const baseSeq = (await one('SELECT COALESCE(MAX(seq),1000) AS m FROM invoices')).m;
await invoice(baseSeq + 1, 0, 'sent', [0, 9], 5, 100);   // Akal (login) — SENT, partial pay → visible in portal
await invoice(baseSeq + 2, 1, 'paid', [1, 7], 6, null);  // KLF — will mark paid below
await invoice(baseSeq + 3, 2, 'draft', [2], 5, null);    // Rivera — draft
// mark the 'paid' one actually paid in full
await q("UPDATE invoice_payments SET amount=(SELECT COALESCE(SUM(amount),0) FROM invoice_lines il WHERE il.invoice_id=invoice_payments.invoice_id) WHERE invoice_id IN (SELECT id FROM invoices WHERE seq=$1)", [baseSeq + 2]);
await q("INSERT INTO invoice_payments (invoice_id,amount,method,paid_at) SELECT id,(SELECT COALESCE(SUM(amount),0) FROM invoice_lines il WHERE il.invoice_id=i.id),'ACH',CURRENT_DATE FROM invoices i WHERE i.seq=$1", [baseSeq + 2]);

// --- DVIR -------------------------------------------------------------------
async function dvir(kind, truckIdx, ci, defects, status) {
  await q("INSERT INTO dvir_reports (kind,truck_id,driver_id,odometer,location,defect_items,remarks,satisfactory,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [kind, truckIds[truckIdx], (driversByCarrier[ci] || [])[0] || null, 250000 + truckIdx * 5000, 'Akal Yard', defects.join('\n') || null,
     (defects.length ? 'Needs shop attention. ' : 'All good. ') + D, defects.length === 0, status]);
}
await dvir('pre_trip', 0, 0, [], 'cleared');
await dvir('post_trip', 1, 1, [], 'cleared');
await dvir('pre_trip', 2, 2, ['Tires', 'Brakes'], 'reviewed');
await dvir('pre_trip', 3, 3, [], 'submitted');
await dvir('post_trip', 4, 0, ['Lights & reflectors'], 'submitted');

// --- expenses ---------------------------------------------------------------
const EXP = [['fuel', 512.40, 'Fuel — Pilot #442'], ['tolls', 38.75, 'I-80 tolls'], ['repair', 410.00, 'Tire replacement'],
  ['fuel', 604.10, 'Fuel — Loves'], ['permit', 90.00, 'Oversize permit'], ['lumper', 175.00, 'Lumper at Exemplis'],
  ['office', 220.00, 'Software subscription'], ['fuel', 488.25, 'Fuel — TA']];
for (let i = 0; i < EXP.length; i++) {
  const [cat, amt, desc] = EXP[i];
  await q("INSERT INTO expenses (category,amount,description,expense_date,truck_id,carrier_id) VALUES ($1,$2,$3,CURRENT_DATE - ($4||' days')::interval,$5,$6)",
    [cat, amt, desc + ' ' + D, String(i * 2), truckIds[i % truckIds.length], carrierIds[i % 4]]);
}

// --- maintenance ------------------------------------------------------------
const MAINT = [['service', 'Oil change + DOT inspection', 'Speedco', 320, 'completed', 30], ['repair', 'Alternator replacement', 'Cascade Diesel', 890, 'completed', null],
  ['tire', 'Drive tires x4', 'Les Schwab', 1450, 'completed', 60], ['inspection', 'Annual DOT inspection', 'Fleet Services', 180, 'scheduled', 7]];
const isoDay = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
for (let i = 0; i < MAINT.length; i++) {
  const [kind, desc, vendor, cost, status, dueIn] = MAINT[i];
  await q(`INSERT INTO maintenance_records (truck_id,kind,description,vendor,cost,odometer,service_date,next_due_date,status)
           VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9)`,
    [truckIds[i], kind, desc + ' ' + D, vendor, cost, 300000 + i * 1000, isoDay(-i * 10), dueIn == null ? null : isoDay(dueIn), status]);
}

console.log('\n✓ Demo data seeded.');
console.log('  Owner-op portal login:  ownerop@bsgcarriers.test  /  ' + OO_PASS);
console.log('  Staff logins (Password2026!):  manager@bsg.test (manager), dispatcher@bsg.test (dispatcher)');
console.log('  Remove it all later with:  node scripts/seed-testdata.mjs --clean');
await client.end();

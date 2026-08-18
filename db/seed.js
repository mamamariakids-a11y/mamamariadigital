// CLI entry point: `npm run seed`. Seeding now also happens automatically on
// first boot (see db/index.js), so this script mostly exists for local
// development convenience and to print out the demo credentials.
const db = require('./index');
const { seedIfEmpty } = require('./seed-data');

(async () => {
  await db.ready; // wait for schema to be created first

  const didSeed = await seedIfEmpty(db);

  if (!didSeed) {
    console.log('قاعدة البيانات تحتوي بيانات بالفعل، تم تخطي التعبئة الأولية.');
  } else {
    console.log('تمت تعبئة قاعدة البيانات بالبيانات الأولية بنجاح.');
  }

  console.log('---------------------------------------------');
  console.log('مديرة الروضة : mama.mariakids@gmail.com / Admin@2026');
  console.log('المديرة التربوية : director@mamamaria.test / Director@123');
  console.log('مربية (فصل البراعم) : teacher1@mamamaria.test / Teacher@123');
  console.log('مربية (فصل الفراشات) : teacher2@mamamaria.test / Teacher@123');
  console.log('ولي أمر : parent1@mamamaria.test / Parent@123');
  console.log('---------------------------------------------');
  process.exit(0);
})();

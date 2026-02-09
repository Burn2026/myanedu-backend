const { Pool } = require('pg');

// Neon Database Connection String
// ⚠️ အောက်က '...' နေရာမှာ ဆရာ Copy ကူးလာတဲ့ Link ကို ထည့်ပါ
const connectionString = 'postgresql://neondb_owner:npg_ycLvJ51aCfGQ@ep-frosty-band-a1h353ix-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require'; 

const pool = new Pool({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false, // Cloud Database ဖြစ်လို့ SSL ခွင့်ပြုရပါမယ်
  },
});

module.exports = pool;
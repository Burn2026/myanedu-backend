const { Pool } = require('pg');
require('dotenv').config(); // .env ဖိုင်ရှိရင် ဖတ်မယ်

// Render (သို့) Local စက်ထဲက Environment Variable ကို ယူပါမယ်
const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false, // Neon Database (Cloud) အတွက် မဖြစ်မနေ လိုအပ်ပါတယ်
  },
});

// Connection စမ်းသပ်ခြင်း (Log ထုတ်ကြည့်ရန်)
pool.connect((err, client, release) => {
  if (err) {
    console.error('🔥 Error acquiring client', err.stack);
  } else {
    console.log('✅ Connected to Database successfully!');
    client.query('SELECT NOW()', (err, result) => {
      release();
      if (err) {
        console.error('🔥 Error executing query', err.stack);
      } else {
        console.log(`🕒 Database Time: ${result.rows[0].now}`);
      }
    });
  }
});

module.exports = pool;
const express = require('express');
const cors = require('cors');
const pool = require('./db');
const path = require('path');
const fs = require('fs');

// Routes Imports
const adminRoutes = require('./routes/adminRoutes');
const studentRoutes = require('./routes/studentRoutes');
const publicRoutes = require('./routes/publicRoutes');

const app = express();
const port = process.env.PORT || 3000; // Render က ပေးတဲ့ Port ကို သုံးပါမယ်

// --- MIDDLEWARE ---
// CORS Error မတက်အောင် Allow All လုပ်ထားပါမယ်
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '5gb' }));
app.use(express.urlencoded({ limit: '5gb', extended: true }));

// Request Logger
app.use((req, res, next) => {
    console.log(`➡️ [REQUEST] ${req.method} ${req.path}`);
    next();
});

// Static Files
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(uploadDir));

// --- HELPER: FULL DATABASE SETUP (For New Neon DB) ---
const ensureDatabaseSchema = async () => {
    const client = await pool.connect();
    try {
        console.log("🔄 Checking & Creating Database Tables...");
        await client.query('BEGIN');

        // 1. Students Table
        await client.query(`
            CREATE TABLE IF NOT EXISTS students (
                id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                phone_primary VARCHAR(50) UNIQUE NOT NULL,
                phone_secondary VARCHAR(50),
                password VARCHAR(255) NOT NULL,
                address TEXT,
                profile_image TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 2. Courses Table
        await client.query(`
            CREATE TABLE IF NOT EXISTS courses (
                id SERIAL PRIMARY KEY,
                title VARCHAR(255) NOT NULL,
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 3. Batches Table
        await client.query(`
            CREATE TABLE IF NOT EXISTS batches (
                id VARCHAR(50) PRIMARY KEY, -- e.g., 'C1-B1'
                course_id INTEGER REFERENCES courses(id),
                batch_name VARCHAR(255) NOT NULL,
                start_date DATE,
                fees DECIMAL(10,2) DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 4. Enrollments Table (with expire_date included)
        await client.query(`
            CREATE TABLE IF NOT EXISTS enrollments (
                id SERIAL PRIMARY KEY,
                student_id UUID REFERENCES students(id) ON DELETE CASCADE,
                batch_id VARCHAR(50) REFERENCES batches(id),
                status VARCHAR(20) DEFAULT 'pending', -- pending, active, inactive
                joined_at DATE DEFAULT CURRENT_DATE,
                expire_date TIMESTAMP DEFAULT (NOW() + INTERVAL '30 days')
            );
        `);

        // 5. Payments Table
        await client.query(`
            CREATE TABLE IF NOT EXISTS payments (
                id SERIAL PRIMARY KEY,
                enrollment_id INTEGER REFERENCES enrollments(id) ON DELETE CASCADE,
                amount DECIMAL(10,2) NOT NULL,
                payment_method VARCHAR(50),
                receipt_image TEXT,
                status VARCHAR(20) DEFAULT 'pending', -- pending, verified, rejected
                payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 6. Lessons Table
        await client.query(`
            CREATE TABLE IF NOT EXISTS lessons (
                id SERIAL PRIMARY KEY,
                batch_id VARCHAR(50), -- Just storing ID string to match previous logic
                title VARCHAR(255) NOT NULL,
                video_url TEXT,
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 7. Comments Table
        await client.query(`
            CREATE TABLE IF NOT EXISTS comments (
                id SERIAL PRIMARY KEY,
                lesson_id INTEGER REFERENCES lessons(id) ON DELETE CASCADE,
                user_name VARCHAR(255),
                user_role VARCHAR(50), 
                message TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 8. Notifications Table
        await client.query(`
            CREATE TABLE IF NOT EXISTS notifications (
                id SERIAL PRIMARY KEY,
                student_id UUID REFERENCES students(id) ON DELETE CASCADE,
                message TEXT NOT NULL,
                type VARCHAR(20) DEFAULT 'info',
                is_read BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 9. Exam Results Table
        await client.query(`
            CREATE TABLE IF NOT EXISTS exam_results (
                id SERIAL PRIMARY KEY,
                enrollment_id INTEGER REFERENCES enrollments(id) ON DELETE CASCADE,
                exam_title VARCHAR(255),
                marks_obtained INTEGER,
                total_marks INTEGER DEFAULT 100,
                grade VARCHAR(10),
                result_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query('COMMIT');
        console.log("✅ Database Setup Complete: All tables are ready.");
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("⚠️ Database Setup Failed:", err.message);
    } finally {
        client.release();
    }
};

// --- USE ROUTES ---
app.use('/admin', adminRoutes);     
app.use('/students', studentRoutes); 
app.use('/public', publicRoutes);   

app.get('/', (req, res) => res.json({ message: 'MyanEdu Server is Running on Render/Neon!' }));

// --- SERVER START ---
const server = app.listen(port, async () => {
  console.log(`🚀 Server is running on port ${port}`);
  await ensureDatabaseSchema(); // Run the setup script on start
});
server.setTimeout(60 * 60 * 1000); // Timeout ကို ၁ နာရီအထိ တိုးထားပါမယ်
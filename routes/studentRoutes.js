// Payment upload fix updated
const express = require('express');
const router = express.Router();
const pool = require('../db');
const upload = require('../config/upload'); // multer config (Cloudinary)
const { cleanImagePath } = require('../utils/helpers');

// --- SYSTEM FIX ROUTES (Database ပြင်ဆင်ရန်) ---
// ⚠️ Browser တွင် ဤလမ်းကြောင်းကို တစ်ကြိမ် Run ပေးပါ: https://myanedu-backend.onrender.com/students/fix-fees
router.get('/fix-fees', async (req, res) => {
    try {
        // fees column မရှိသေးလျှင် ထည့်မည်
        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='batches' AND column_name='fees') THEN 
                    ALTER TABLE batches ADD COLUMN fees DECIMAL(10,2) DEFAULT 0; 
                END IF;
            END $$;
        `);
        
        // ဈေးနှုန်းများကို Default 30,000 ဟု ယာယီသတ်မှတ်မည် (Admin Panel တွင် ပြန်ပြင်နိုင်သည်)
        await pool.query("UPDATE batches SET fees = 30000 WHERE fees IS NULL OR fees = 0");
        
        res.send("✅ Success: 'fees' column added to batches table and updated!");
    } catch (err) {
        console.error(err);
        res.status(500).send("Error updating DB: " + err.message);
    }
});

// --- NOTIFICATION ROUTES ---
router.get('/:id/notifications', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM notifications WHERE student_id = $1 ORDER BY created_at DESC LIMIT 20", [req.params.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).send("Server Error"); }
});

router.put('/notifications/:id/read', async (req, res) => {
    try {
        await pool.query("UPDATE notifications SET is_read = TRUE WHERE id = $1", [req.params.id]);
        res.json({ message: "Marked as read" });
    } catch (err) { res.status(500).send("Server Error"); }
});

// --- STUDENT DATA ROUTES ---

// 1. Get All Students
router.get('/', async (req, res) => {
    try {
        const allStudents = await pool.query('SELECT * FROM students ORDER BY id DESC');
        res.json(allStudents.rows);
    } catch (err) { res.status(500).send('Server Error'); }
});

// 2. Search Student
router.get('/search', async (req, res) => {
    try {
        const { phone } = req.query;
        if (!phone) return res.status(400).json({ message: "Phone required" });
        const student = await pool.query('SELECT * FROM students WHERE phone_primary = $1', [phone]);
        if (student.rows.length === 0) return res.status(404).json({ message: "Not found" });
        res.json(student.rows[0]);
    } catch (err) { res.status(500).send('Server Error'); }
});

// ✅ (UPDATED) Get Active Batches with Fees for Payment Dropdown
// ဤ Route သည် Frontend တွင် အတန်းရွေးရန်နှင့် ဈေးနှုန်းပြရန် အလုပ်လုပ်ပါမည်
router.get('/active-batches', async (req, res) => {
    try {
        // batches ဇယားနှင့် courses ဇယားကို တွဲပြီး ဈေးနှုန်း (fees) ပါ ယူမည်
        const query = `
            SELECT b.id, b.batch_name, b.fees, c.title as course_name 
            FROM batches b
            JOIN courses c ON b.course_id = c.id
            WHERE b.status = 'active' OR b.status = 'open'
            ORDER BY c.title ASC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("🔥 Active Batches Error:", err.message);
        // Column မရှိသေးလျှင် Frontend ကို သတိပေးမည်
        res.status(500).json({ error: err.message, hint: "Please run /students/fix-fees route once." });
    }
});

// 3. Get Payments
router.get('/payments', async (req, res) => {
    try {
        const { phone } = req.query;
        const query = `
          SELECT p.id, p.transaction_id, p.amount, p.payment_method, p.payment_date, p.status, p.receipt_image,
                 c.title as course_name, b.batch_name, b.id as batch_id, e.expire_date, e.status as enrollment_status
          FROM payments p 
          JOIN enrollments e ON p.enrollment_id = e.id 
          JOIN students s ON e.student_id = s.id 
          JOIN batches b ON e.batch_id = b.id 
          JOIN courses c ON b.course_id = c.id
          WHERE s.phone_primary = $1 ORDER BY p.payment_date DESC
        `;
        const result = await pool.query(query, [phone]);
        const fixedRows = result.rows.map(row => ({ ...row, receipt_image: cleanImagePath(row.receipt_image) }));
        res.json(fixedRows);
    } catch (err) { 
        console.error(err);
        res.status(500).send('Server Error'); 
    }
});

// 4. Get Exams
router.get('/exams', async (req, res) => {
    try {
        const { phone } = req.query;
        const query = `
            SELECT er.*, c.title as course_name, b.batch_name 
            FROM exam_results er 
            JOIN enrollments e ON er.enrollment_id = e.id 
            JOIN students s ON e.student_id = s.id 
            JOIN batches b ON e.batch_id = b.id 
            JOIN courses c ON b.course_id = c.id 
            WHERE s.phone_primary = $1 
            ORDER BY er.result_date DESC
        `;
        const result = await pool.query(query, [phone]);
        res.json(result.rows);
    } catch (err) { 
        console.error(err);
        res.status(500).send('Server Error'); 
    }
});

// 5. Update Student Profile
router.put('/profile/:id', upload.single('profile_image'), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, address, old_password, new_password } = req.body;
        const currentStudent = await pool.query("SELECT * FROM students WHERE id = $1", [id]);
        if (currentStudent.rows.length === 0) return res.status(404).json({ message: "Not Found" });
        
        const oldData = currentStudent.rows[0];
        let finalPassword = oldData.password;
        if (new_password && new_password.trim() !== "") {
            if (!old_password) return res.status(400).json({ message: "Need Old Password" });
            if (old_password !== oldData.password) return res.status(401).json({ message: "Wrong Old Password" });
            finalPassword = new_password;
        }

        let newImage = oldData.profile_image;
        if (req.file) newImage = req.file.path; 

        await pool.query("UPDATE students SET name=$1, password=$2, address=$3, profile_image=$4 WHERE id=$5", [name || oldData.name, finalPassword, address || oldData.address, newImage, id]);
        res.json({ message: "Updated!" });
    } catch (err) { res.status(500).send("Server Error"); }
});

// 6. Admin Update Student Info
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, phone_primary, phone_secondary, address } = req.body;
        
        await pool.query(
            "UPDATE students SET name = $1, phone_primary = $2, phone_secondary = $3, address = $4 WHERE id = $5",
            [name, phone_primary, phone_secondary, address, id]
        );
        res.json({ message: "Updated successfully" });
    } catch (err) { 
        console.error(err);
        res.status(500).send("Server Error"); 
    }
});

// 7. Enroll
router.post('/enroll', async (req, res) => {
    try {
        const { phone, batch_name } = req.body;
        const studentRes = await pool.query("SELECT id FROM students WHERE phone_primary = $1", [phone]);
        if (studentRes.rows.length === 0) return res.status(404).json({ message: "Student not found" });
        const batchRes = await pool.query("SELECT id FROM batches WHERE batch_name = $1", [batch_name]);
        if (batchRes.rows.length === 0) return res.status(404).json({ message: "Batch not found" });
        
        const newEnrollment = await pool.query("INSERT INTO enrollments (student_id, batch_id, joined_at, status) VALUES ($1, $2, CURRENT_DATE, 'active') RETURNING *", [studentRes.rows[0].id, batchRes.rows[0].id]);
        res.json(newEnrollment.rows[0]);
    } catch (err) { res.status(500).send("Server Error"); }
});

// 8. Make Payment (Updated Logic)
router.post('/payments', async (req, res) => {
    try {
        const { phone, amount, payment_method, transaction_id, batch_id } = req.body; 
        
        // ကျောင်းသား ID ရှာမည်
        const studentRes = await pool.query("SELECT id FROM students WHERE phone_primary = $1", [phone]);
        if (studentRes.rows.length === 0) return res.status(404).json({ message: "Student not found" });
        const studentId = studentRes.rows[0].id;

        // Enrollment ရှိမရှိ စစ်ဆေးခြင်း (batch_id ပါပါက ထို batch အတွက် enrollment ရှာမည်)
        let enrollmentId;
        
        if (batch_id) {
            // Batch ID ပါလာလျှင် Enrollment အသစ်လုပ်ရန် လိုမလို စစ်ဆေးမည်
            const existingEnrollment = await pool.query(
                "SELECT id FROM enrollments WHERE student_id = $1 AND batch_id = $2",
                [studentId, batch_id]
            );

            if (existingEnrollment.rows.length > 0) {
                enrollmentId = existingEnrollment.rows[0].id;
            } else {
                // Enrollment မရှိသေးပါက အသစ်ဖန်တီးမည် (Auto Enroll)
                const newEnrollment = await pool.query(
                    "INSERT INTO enrollments (student_id, batch_id, joined_at, status) VALUES ($1, $2, CURRENT_DATE, 'pending') RETURNING id",
                    [studentId, batch_id]
                );
                enrollmentId = newEnrollment.rows[0].id;
            }
        } else {
            // Batch ID မပါလျှင် နောက်ဆုံး Enrollment ကိုသာ ယူမည် (Old logic fallback)
            const lastEnrollment = await pool.query(
                "SELECT id FROM enrollments WHERE student_id = $1 ORDER BY joined_at DESC LIMIT 1",
                [studentId]
            );
            if (lastEnrollment.rows.length === 0) return res.status(400).json({ message: "No enrollment found. Please select a course." });
            enrollmentId = lastEnrollment.rows[0].id;
        }
        
        // Payment သိမ်းဆည်းခြင်း
        const newPayment = await pool.query(
            `INSERT INTO payments (enrollment_id, amount, payment_method, transaction_id, status, payment_date) 
             VALUES ($1, $2, $3, $4, 'verified', CURRENT_TIMESTAMP) RETURNING *`, 
            [enrollmentId, amount, payment_method, transaction_id]
        );
        res.json(newPayment.rows[0]);

    } catch (err) { 
        console.error(err);
        res.status(500).send("Server Error"); 
    }
});

// 9. Post Comment
router.post('/comments', async (req, res) => {
    try {
        const { lesson_id, user_name, message } = req.body;
        await pool.query(
            "INSERT INTO comments (lesson_id, user_name, user_role, message) VALUES ($1, $2, 'student', $3)",
            [lesson_id, user_name, message]
        );
        res.json({ message: "Comment added" });
    } catch (err) { res.status(500).send("Server Error"); }
});

// 10. Delete Student
router.delete('/:id', async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        await client.query('BEGIN');

        await client.query("DELETE FROM notifications WHERE student_id = $1", [id]);
        await client.query("DELETE FROM exam_results WHERE enrollment_id IN (SELECT id FROM enrollments WHERE student_id = $1)", [id]);
        await client.query("DELETE FROM payments WHERE enrollment_id IN (SELECT id FROM enrollments WHERE student_id = $1)", [id]);
        await client.query("DELETE FROM enrollments WHERE student_id = $1", [id]);
        const result = await client.query("DELETE FROM students WHERE id = $1", [id]);

        if (result.rowCount === 0) {
             await client.query('ROLLBACK');
             return res.status(404).json({ message: "Student not found" });
        }

        await client.query('COMMIT');
        res.json({ message: "Deleted Successfully!" });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Delete Error:", err.message);
        res.status(500).send("Server Error: " + err.message);
    } finally {
        client.release();
    }
});

module.exports = router;
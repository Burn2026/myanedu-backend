const express = require('express');
const router = express.Router();
const pool = require('../db'); 
const upload = require('../config/upload'); // Cloudinary Config
const { cleanImagePath } = require('../utils/helpers');

// --- SYSTEM FIX ROUTE (Batch Status ပြင်ဆင်ရန်) ---
router.get('/fix-batch-status', async (req, res) => {
    try {
        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='batches' AND column_name='status') THEN 
                    ALTER TABLE batches ADD COLUMN status VARCHAR(20) DEFAULT 'active'; 
                END IF;
            END $$;
        `);
        
        await pool.query("UPDATE batches SET status = 'active' WHERE status IS NULL OR status = ''");
        res.send("✅ Success: All batches are now ACTIVE and visible to students!");
    } catch (err) {
        console.error(err);
        res.status(500).send("Error updating DB: " + err.message);
    }
});

// --- 1. VERIFY PAYMENT LOGIC ---
const verifyPaymentHandler = async (req, res) => {
    try {
        const { id } = req.params;
        const paymentUpdate = await pool.query(
            "UPDATE payments SET status = 'verified' WHERE id = $1 RETURNING *",
            [id]
        );

        if (paymentUpdate.rows.length === 0) return res.status(404).json({ message: "Payment not found" });

        const enrollmentId = paymentUpdate.rows[0].enrollment_id;
        if (enrollmentId) {
            await pool.query(
                `UPDATE enrollments SET expire_date = NOW() + INTERVAL '30 days', status = 'active' WHERE id = $1`,
                [enrollmentId]
            );
            
            try {
                const info = await pool.query(
                    `SELECT e.student_id, b.batch_name, c.title FROM enrollments e 
                     JOIN batches b ON e.batch_id = b.id JOIN courses c ON b.course_id = c.id WHERE e.id = $1`,
                    [enrollmentId]
                );
                if (info.rows.length > 0) {
                    const { student_id, batch_name, title } = info.rows[0];
                    await pool.query("INSERT INTO notifications (student_id, message, type) VALUES ($1, $2, 'success')", 
                    [student_id, `✅ Payment verified for ${title} (${batch_name}).`]);
                }
            } catch (err) { console.error("Noti Error:", err.message); }
        }
        res.json(paymentUpdate.rows[0]);
    } catch (err) { res.status(500).json({ message: err.message }); }
};

// --- REJECT PAYMENT LOGIC ---
const rejectPaymentHandler = async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        await client.query('BEGIN');

        const paymentUpdate = await client.query(
            "UPDATE payments SET status = 'rejected' WHERE id = $1 RETURNING *", 
            [id]
        );

        if (paymentUpdate.rows.length === 0) {
             await client.query('ROLLBACK');
             return res.status(404).json({ message: "Payment record not found" });
        }

        const enrollmentId = paymentUpdate.rows[0].enrollment_id;
        
        if (enrollmentId) {
            await client.query(
                "UPDATE enrollments SET status = 'rejected', expire_date = (NOW() - INTERVAL '1 day') WHERE id = $1", 
                [enrollmentId]
            );
        }

        await client.query('COMMIT');
        res.json({ message: "Payment Rejected Successfully" });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("🔥 Reject Error:", err.message);
        res.status(500).json({ message: err.message });
    } finally { client.release(); }
};

// --- 3. COURSE & BATCH ROUTES ---

// ✅ (UPDATED) get batches route with lesson_count
router.get('/batches', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT b.*, c.title as course_name,
                   (SELECT COUNT(*) FROM lessons l WHERE l.batch_id::text = b.id::text) as lesson_count
            FROM batches b 
            JOIN courses c ON b.course_id = c.id 
            ORDER BY b.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) { 
        console.error("Fetch Batches Error:", err);
        res.status(500).send("Error fetching batches"); 
    }
});

router.post('/courses', async (req, res) => {
    try {
        const { title, description } = req.body;
        const result = await pool.query("INSERT INTO courses (title, description) VALUES ($1, $2) RETURNING *", [title, description]);
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json(err.message); }
});

router.post('/batches', async (req, res) => {
    try {
        const { id, course_id, batch_name, fees } = req.body;
        const result = await pool.query(
            "INSERT INTO batches (id, course_id, batch_name, fees, status) VALUES ($1, $2, $3, $4, 'active') RETURNING *", 
            [id, course_id, batch_name, fees]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json(err.message); }
});

router.put('/batches/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { batch_name, fees, status } = req.body;
        
        await pool.query(
            "UPDATE batches SET batch_name = $1, fees = $2, status = $3 WHERE id = $4",
            [batch_name, fees, status, id]
        );
        res.json({ message: "Batch Updated Successfully" });
    } catch (err) { res.status(500).json(err.message); }
});

// --- 4. STUDENT & STATS ROUTES ---
router.get('/students', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM students ORDER BY created_at DESC");
        res.json(result.rows);
    } catch (err) { res.status(500).send("Error"); }
});

router.get('/stats', async (req, res) => {
    try {
        const sCount = await pool.query("SELECT COUNT(*) FROM students");
        const income = await pool.query("SELECT SUM(amount) FROM payments WHERE status = 'verified'");
        res.json({ total_students: sCount.rows[0].count, total_income: income.rows[0].sum || 0 });
    } catch (err) { res.status(500).send("Error"); }
});

// --- PAYMENT ROUTES ---
router.get('/payments', async (req, res) => {
    try {
        const query = `
          SELECT p.*, s.name as student_name, s.phone_primary, c.title as course_name, b.batch_name
          FROM payments p
          JOIN enrollments e ON p.enrollment_id = e.id
          JOIN students s ON e.student_id = s.id
          JOIN batches b ON e.batch_id = b.id
          JOIN courses c ON b.course_id = c.id
          ORDER BY CASE WHEN p.status = 'pending' THEN 1 ELSE 2 END, p.payment_date DESC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

router.put('/payments/:id', async (req, res) => {
    const { status } = req.body;
    if (status === 'verified') return verifyPaymentHandler(req, res);
    if (status === 'rejected') return rejectPaymentHandler(req, res);
    res.status(400).json("Invalid Status");
});

// --- 6. LESSONS & DISCUSSIONS ---
router.post('/lessons', upload.single('video_file'), async (req, res) => {
    try {
        const { batch_id, title, description } = req.body;
        const videoUrl = req.file ? req.file.path : null; 
        const result = await pool.query("INSERT INTO lessons (batch_id, title, video_url, description) VALUES ($1, $2, $3, $4) RETURNING *", [batch_id, title, videoUrl, description]);
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json("Error"); }
});

// ✅ (NEW) လိုအပ်နေသော DELETE Route for lessons
router.delete('/lessons/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query("DELETE FROM lessons WHERE id = $1", [id]);
        res.json({ message: "Lesson deleted successfully" });
    } catch (err) {
        console.error("Delete Lesson Error:", err);
        res.status(500).send("Server Error");
    }
});

router.get('/discussions', async (req, res) => {
    try {
        const query = `
            SELECT l.id, l.title as lesson_title, b.batch_name, COUNT(co.id) as total_comments
            FROM lessons l JOIN comments co ON l.id = co.lesson_id
            LEFT JOIN batches b ON l.batch_id = b.id::text GROUP BY l.id, l.title, b.batch_name
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) { res.status(500).send("Error"); }
});

// --- 7. EXAMS ---
router.get('/exams', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT er.*, s.name as student_name, b.batch_name 
            FROM exam_results er JOIN enrollments e ON er.enrollment_id = e.id
            JOIN students s ON e.student_id = s.id JOIN batches b ON e.batch_id = b.id
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).send("Error"); }
});

// --- 8. DATABASE FIX ---
router.get('/fix-database', async (req, res) => {
    try {
        await pool.query("ALTER TABLE payments ADD COLUMN IF NOT EXISTS transaction_id VARCHAR(50)");
        res.send("✅ Database Fixed!");
    } catch (err) { res.status(500).send(err.message); }
});

module.exports = router;
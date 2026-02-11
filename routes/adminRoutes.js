const express = require('express');
const router = express.Router();
const pool = require('../db'); // database connection
const upload = require('../config/upload'); // multer config (Cloudinary)
const { cleanImagePath } = require('../utils/helpers');

// --- VERIFY PAYMENT LOGIC ---
const verifyPaymentHandler = async (req, res) => {
    try {
        const { id } = req.params;
        console.log(`🔄 [Verify] Processing Payment ID: ${id}`);

        const paymentUpdate = await pool.query(
            "UPDATE payments SET status = 'verified' WHERE id = $1 RETURNING *",
            [id]
        );

        if (paymentUpdate.rows.length === 0) return res.status(404).json({ message: "Payment not found" });

        const updatedPayment = paymentUpdate.rows[0];
        const enrollmentId = updatedPayment.enrollment_id;

        if (enrollmentId) {
            await pool.query(
                `UPDATE enrollments SET expire_date = NOW() + INTERVAL '30 days', status = 'active' WHERE id = $1`,
                [enrollmentId]
            );
            
            try {
                const enrollmentInfo = await pool.query(
                    `SELECT e.student_id, b.batch_name, c.title as course_name 
                     FROM enrollments e JOIN batches b ON e.batch_id = b.id JOIN courses c ON b.course_id = c.id WHERE e.id = $1`,
                    [enrollmentId]
                );
                if (enrollmentInfo.rows.length > 0) {
                    const { student_id, batch_name, course_name } = enrollmentInfo.rows[0];
                    const message = `✅ Payment verified for ${course_name} (${batch_name}). Subscription active for 30 days!`;
                    await pool.query("INSERT INTO notifications (student_id, message, type) VALUES ($1, $2, 'success')", [student_id, message]);
                }
            } catch (notiError) { console.error("⚠️ Noti Error:", notiError.message); }
        }
        res.json(updatedPayment);
    } catch (err) {
        console.error("🔥 [Verify] ERROR:", err.message);
        res.status(500).json({ message: err.message });
    }
};

// --- REJECT PAYMENT LOGIC ---
const rejectPaymentHandler = async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        console.log(`❌ [Reject] Processing Payment ID: ${id}`);
        await client.query('BEGIN');

        const paymentUpdate = await client.query("UPDATE payments SET status = 'rejected' WHERE id = $1 RETURNING *", [id]);
        if (paymentUpdate.rows.length === 0) {
             await client.query('ROLLBACK');
             return res.status(404).json({ message: "Payment not found" });
        }

        const enrollmentId = paymentUpdate.rows[0].enrollment_id;
        
        if (enrollmentId) {
            await client.query(
                "UPDATE enrollments SET expire_date = (NOW() - INTERVAL '1 day') WHERE id = $1", 
                [enrollmentId]
            );
            
            const enrollmentInfo = await client.query(
                `SELECT e.student_id, b.batch_name, c.title as course_name FROM enrollments e JOIN batches b ON e.batch_id = b.id JOIN courses c ON b.course_id = c.id WHERE e.id = $1`,
                [enrollmentId]
            );
            if (enrollmentInfo.rows.length > 0) {
                const { student_id, batch_name, course_name } = enrollmentInfo.rows[0];
                const message = `❌ Payment Rejected for ${course_name} (${batch_name}). Access has been revoked.`;
                await client.query("INSERT INTO notifications (student_id, message, type) VALUES ($1, $2, 'error')", [student_id, message]);
            }
        }
        await client.query('COMMIT');
        res.json(paymentUpdate.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("🔥 [Reject DB Error]:", err.message);
        res.status(500).json({ message: err.message });
    } finally { client.release(); }
};

// ==========================================
// 🆕 NEW FEATURES ADDED BELOW (Course & Batch)
// ==========================================

// 1. Create New Course
router.post('/courses', async (req, res) => {
    try {
        const { title, description } = req.body;
        const newCourse = await pool.query(
            "INSERT INTO courses (title, description) VALUES ($1, $2) RETURNING *",
            [title, description]
        );
        res.json(newCourse.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).json("Error creating course");
    }
});

// 2. Create New Batch
router.post('/batches', async (req, res) => {
    try {
        const { id, course_id, batch_name, fees } = req.body;
        const newBatch = await pool.query(
            "INSERT INTO batches (id, course_id, batch_name, fees) VALUES ($1, $2, $3, $4) RETURNING *",
            [id, course_id, batch_name, fees]
        );
        res.json(newBatch.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).json("Error creating batch");
    }
});

// 3. Get All Students (For Manage Students Tab)
router.get('/students', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM students ORDER BY created_at DESC");
        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server Error fetching students");
    }
});

// ==========================================
// EXISTING FEATURES CONTINUED...
// ==========================================

// --- DISCUSSION ROUTES ---
router.get('/discussions', async (req, res) => {
    try {
        const query = `
            SELECT l.id, l.title as lesson_title, 
                   b.batch_name, c.title as course_name,
                   COUNT(co.id) as total_comments, 
                   MAX(co.created_at) as last_active
            FROM lessons l
            JOIN comments co ON l.id = co.lesson_id
            LEFT JOIN batches b ON l.batch_id = b.id::text
            LEFT JOIN courses c ON b.course_id = c.id
            GROUP BY l.id, l.title, b.batch_name, c.title
            ORDER BY last_active DESC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) { 
        console.error(err);
        res.status(500).send("Server Error"); 
    }
});

router.get('/comments', async (req, res) => {
    try {
        const { lesson_id } = req.query;
        const result = await pool.query(
            "SELECT * FROM comments WHERE lesson_id = $1 ORDER BY created_at ASC",
            [lesson_id]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).send("Server Error"); }
});

router.post('/comments', async (req, res) => {
    try {
        const { lesson_id, message } = req.body;
        await pool.query(
            "INSERT INTO comments (lesson_id, user_name, user_role, message) VALUES ($1, 'Teacher (Admin)', 'admin', $2)",
            [lesson_id, message]
        );
        res.json({ message: "Reply added" });
    } catch (err) { res.status(500).send("Server Error"); }
});

// --- EXAM MANAGEMENT ROUTES ---

// 1. Get All Exams
router.get('/exams', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT er.*, s.name as student_name, s.phone_primary, b.batch_name, c.title as course_name 
            FROM exam_results er
            JOIN enrollments e ON er.enrollment_id = e.id
            JOIN students s ON e.student_id = s.id
            JOIN batches b ON e.batch_id = b.id
            JOIN courses c ON b.course_id = c.id
            ORDER BY er.result_date DESC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).send("Server Error"); }
});

// 2. Get Student's Enrolled Batches by Phone
router.get('/student-batches', async (req, res) => {
    try {
        const { phone } = req.query;
        const query = `
            SELECT e.id as enrollment_id, b.batch_name, c.title as course_name
            FROM enrollments e
            JOIN students s ON e.student_id = s.id
            JOIN batches b ON e.batch_id = b.id
            JOIN courses c ON b.course_id = c.id
            WHERE s.phone_primary = $1 AND e.status = 'active'
        `;
        const result = await pool.query(query, [phone]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send("Server Error");
    }
});

// 3. Add New Exam Result
router.post('/exams', async (req, res) => {
    try {
        const { enrollment_id, exam_title, marks_obtained, total_marks, grade } = req.body;

        const newExam = await pool.query(
            `INSERT INTO exam_results (enrollment_id, exam_title, marks_obtained, total_marks, grade) 
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [enrollment_id, exam_title, marks_obtained, total_marks, grade]
        );
        res.json(newExam.rows[0]);

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server Error: " + err.message });
    }
});

// 4. Delete Exam Result
router.delete('/exams/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query("DELETE FROM exam_results WHERE id = $1", [id]);
        res.json({ message: "Deleted Successfully" });
    } catch (err) {
        console.error(err);
        res.status(500).send("Server Error");
    }
});

// --- OTHER ROUTES ---

router.put('/verify-payment/:id', verifyPaymentHandler);
router.put('/reject-payment/:id', rejectPaymentHandler);

router.get('/stats', async (req, res) => {
    try {
        const studentCount = await pool.query("SELECT COUNT(*) FROM students");
        const incomeTotal = await pool.query("SELECT SUM(amount) FROM payments");
        res.json({ total_students: studentCount.rows[0].count, total_income: incomeTotal.rows[0].sum || 0 });
    } catch (err) { res.status(500).send("Server Error"); }
});

router.get('/charts', async (req, res) => {
    try {
        const incomeRes = await pool.query(`SELECT TO_CHAR(payment_date, 'Mon') as name, SUM(amount) as amount FROM payments GROUP BY TO_CHAR(payment_date, 'Mon'), EXTRACT(MONTH FROM payment_date) ORDER BY EXTRACT(MONTH FROM payment_date)`);
        const studentRes = await pool.query(`SELECT c.title as name, COUNT(e.id) as value FROM enrollments e JOIN batches b ON e.batch_id = b.id JOIN courses c ON b.course_id = c.id GROUP BY c.title`);
        res.json({ incomeData: incomeRes.rows, studentData: studentRes.rows });
    } catch (err) { res.status(500).send("Server Error"); }
});

router.get('/payments', async (req, res) => {
    try {
        const query = `
          SELECT p.id, p.amount, p.payment_method, p.payment_date, p.status, p.receipt_image,
                 s.name as student_name, s.phone_primary, c.title as course_name, b.batch_name
          FROM payments p
          JOIN enrollments e ON p.enrollment_id = e.id
          JOIN students s ON e.student_id = s.id
          JOIN batches b ON e.batch_id = b.id
          JOIN courses c ON b.course_id = c.id
          ORDER BY CASE WHEN p.status = 'pending' THEN 1 ELSE 2 END, p.payment_date DESC
        `;
        const result = await pool.query(query);
        const fixedRows = result.rows.map(row => ({ ...row, receipt_image: cleanImagePath(row.receipt_image) }));
        res.json(fixedRows);
    } catch (err) { res.status(500).send("Server Error"); }
});

// POST /lessons (Updated for Cloudinary)
router.post('/lessons', upload.single('video_file'), async (req, res) => {
    try {
        const { batch_id, title, description } = req.body;
        if (!req.file) return res.status(400).json({ message: "No Video File" });
        
        // (UPDATED) Use Cloudinary URL directly from req.file.path
        const videoPath = req.file.path; 

        const newLesson = await pool.query("INSERT INTO lessons (batch_id, title, video_url, description) VALUES ($1, $2, $3, $4) RETURNING *", [batch_id, title, videoPath, description]);
        res.json(newLesson.rows[0]);
    } catch (err) { res.status(500).json({ message: "DB Error" }); }
});

router.delete('/lessons/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM lessons WHERE id = $1", [req.params.id]);
        res.json("Deleted!");
    } catch (err) { res.status(500).send("Server Error"); }
});

module.exports = router;
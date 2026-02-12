const express = require('express');
const router = express.Router();
const pool = require('../db');
const upload = require('../config/upload'); // ✅ Cloudinary Config
const { cleanImagePath } = require('../utils/helpers');

// --- SYSTEM FIX ROUTES ---
router.get('/fix-fees', async (req, res) => {
    try {
        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='batches' AND column_name='fees') THEN 
                    ALTER TABLE batches ADD COLUMN fees DECIMAL(10,2) DEFAULT 0; 
                END IF;
            END $$;
        `);
        await pool.query("UPDATE batches SET fees = 30000 WHERE fees IS NULL OR fees = 0");
        res.send("✅ Success: 'fees' column added/updated!");
    } catch (err) { res.status(500).send("Error: " + err.message); }
});

// --- NOTIFICATIONS ---
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

// --- STUDENT ROUTES ---
router.get('/', async (req, res) => {
    try {
        const allStudents = await pool.query('SELECT * FROM students ORDER BY id DESC');
        res.json(allStudents.rows);
    } catch (err) { res.status(500).send('Server Error'); }
});

router.get('/search', async (req, res) => {
    try {
        const { phone } = req.query;
        if (!phone) return res.status(400).json({ message: "Phone required" });
        const student = await pool.query('SELECT * FROM students WHERE phone_primary = $1', [phone]);
        if (student.rows.length === 0) return res.status(404).json({ message: "Not found" });
        res.json(student.rows[0]);
    } catch (err) { res.status(500).send('Server Error'); }
});

// Get Active Batches
router.get('/active-batches', async (req, res) => {
    try {
        const query = `
            SELECT b.id, b.batch_name, b.fees, c.title as course_name 
            FROM batches b
            JOIN courses c ON b.course_id = c.id
            WHERE b.status = 'active' OR b.status = 'open'
            ORDER BY c.title ASC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get Payments
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
    } catch (err) { res.status(500).send('Server Error'); }
});

// Get Exams
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
            WHERE s.phone_primary = $1 ORDER BY er.result_date DESC
        `;
        const result = await pool.query(query, [phone]);
        res.json(result.rows);
    } catch (err) { res.status(500).send('Server Error'); }
});

// Update Profile
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

// ✅ (UPDATED) Make Payment Route -> Status is now 'pending'
router.post('/payments', upload.single('receipt_image'), async (req, res) => {
    try {
        const { phone, amount, payment_method, transaction_id, batch_id } = req.body; 
        
        // 1. Check for Receipt Image
        const receiptUrl = req.file ? req.file.path : null;
        if (!receiptUrl) {
            return res.status(400).json({ message: "Receipt image is required" });
        }

        // 2. Find Student
        const studentRes = await pool.query("SELECT id FROM students WHERE phone_primary = $1", [phone]);
        if (studentRes.rows.length === 0) return res.status(404).json({ message: "Student not found" });
        const studentId = studentRes.rows[0].id;

        // 3. Handle Enrollment
        let enrollmentId;
        if (batch_id) {
            const existingEnrollment = await pool.query("SELECT id FROM enrollments WHERE student_id = $1 AND batch_id = $2", [studentId, batch_id]);
            if (existingEnrollment.rows.length > 0) {
                enrollmentId = existingEnrollment.rows[0].id;
            } else {
                const newEnrollment = await pool.query(
                    "INSERT INTO enrollments (student_id, batch_id, joined_at, status) VALUES ($1, $2, CURRENT_DATE, 'pending') RETURNING id",
                    [studentId, batch_id]
                );
                enrollmentId = newEnrollment.rows[0].id;
            }
        } else {
            const lastEnrollment = await pool.query("SELECT id FROM enrollments WHERE student_id = $1 ORDER BY joined_at DESC LIMIT 1", [studentId]);
            if (lastEnrollment.rows.length === 0) return res.status(400).json({ message: "No enrollment found." });
            enrollmentId = lastEnrollment.rows[0].id;
        }
        
        // 4. Save Payment with 'pending' status (✅ HERE IS THE FIX)
        const newPayment = await pool.query(
            `INSERT INTO payments (enrollment_id, amount, payment_method, transaction_id, receipt_image, status, payment_date) 
             VALUES ($1, $2, $3, $4, $5, 'pending', CURRENT_TIMESTAMP) RETURNING *`, 
            [enrollmentId, amount, payment_method, transaction_id, receiptUrl]
        );
        
        res.json(newPayment.rows[0]);

    } catch (err) { 
        console.error("Payment Error:", err); 
        res.status(500).json({ message: "Server Error: " + err.message }); 
    }
});

// Other routes
router.post('/comments', async (req, res) => {
    try {
        const { lesson_id, user_name, message } = req.body;
        await pool.query("INSERT INTO comments (lesson_id, user_name, user_role, message) VALUES ($1, $2, 'student', $3)", [lesson_id, user_name, message]);
        res.json({ message: "Comment added" });
    } catch (err) { res.status(500).send("Server Error"); }
});

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
        res.status(500).send("Server Error: " + err.message);
    } finally { client.release(); }
});

module.exports = router;
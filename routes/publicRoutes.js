const express = require('express');
const router = express.Router();
const pool = require('../db');
const upload = require('../config/upload');

router.get('/batches', async (req, res) => {
    try {
        const batches = await pool.query(`SELECT b.id, b.batch_name, c.title as course_name FROM batches b JOIN courses c ON b.course_id = c.id ORDER BY b.id DESC`);
        res.json(batches.rows);
    } catch (err) { res.status(500).send("Server Error"); }
});

router.get('/student-enrollments', async (req, res) => {
    try {
        const { student_id } = req.query;
        const enrollments = await pool.query(`SELECT e.id, b.batch_name, c.title as course_name FROM enrollments e JOIN batches b ON e.batch_id = b.id JOIN courses c ON b.course_id = c.id WHERE e.student_id = $1`, [student_id]);
        res.json(enrollments.rows);
    } catch (err) { res.status(500).send("Server Error"); }
});

router.post('/payment', upload.single('receipt_image'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); 
        const { student_id, batch_id, amount, payment_method, transaction_ref } = req.body;
        const receiptPath = req.file ? `uploads/${req.file.filename}` : null;
        const finalMethod = transaction_ref ? `${payment_method} (Ref: ${transaction_ref})` : payment_method;

        let enrollment_id;
        const checkEnroll = await client.query("SELECT id FROM enrollments WHERE student_id = $1 AND batch_id = $2", [student_id, batch_id]);

        if (checkEnroll.rows.length > 0) {
            enrollment_id = checkEnroll.rows[0].id;
        } else {
            const newEnroll = await client.query("INSERT INTO enrollments (student_id, batch_id, joined_at, status) VALUES ($1, $2, CURRENT_DATE, 'active') RETURNING id", [student_id, batch_id]);
            enrollment_id = newEnroll.rows[0].id;
        }

        await client.query("INSERT INTO payments (enrollment_id, amount, payment_method, status, payment_date, receipt_image) VALUES ($1, $2, $3, 'pending', CURRENT_TIMESTAMP, $4)", [enrollment_id, amount, finalMethod, receiptPath]);
        await client.query('COMMIT'); 
        res.json({ message: "Success" });
    } catch (err) {
        await client.query('ROLLBACK'); 
        res.status(500).send("Server Error");
    } finally { client.release(); }
});

router.post('/register', async (req, res) => {
    try {
        const { name, phone, date_of_birth, address, password } = req.body; 
        const checkPhone = await pool.query('SELECT * FROM students WHERE phone_primary = $1', [phone]);
        if (checkPhone.rows.length > 0) return res.status(400).json({ message: "Phone exists" });

        const newStudent = await pool.query("INSERT INTO students (name, phone_primary, date_of_birth, address, password) VALUES ($1, $2, $3, $4, $5) RETURNING *", [name, phone, date_of_birth, address, password]);
        res.json(newStudent.rows[0]);
    } catch (err) { res.status(500).json({ message: "Server Error" }); }
});

router.post('/login', async (req, res) => {
    try {
        const { phone, password } = req.body;
        const result = await pool.query('SELECT * FROM students WHERE phone_primary = $1 AND password = $2', [phone, password]);
        if (result.rows.length === 0) return res.status(401).json({ message: "Login Failed" });
        res.json(result.rows[0]); 
    } catch (err) { res.status(500).send("Server Error"); }
});

router.get('/promo-courses', async (req, res) => {
    try {
        const courses = await pool.query(`SELECT b.id, b.batch_name, c.title as course_name, b.max_students, COUNT(e.id)::int as current_students FROM batches b JOIN courses c ON b.course_id = c.id LEFT JOIN enrollments e ON b.id = e.batch_id GROUP BY b.id, b.batch_name, c.title, b.max_students ORDER BY b.id DESC`);
        const processedData = courses.rows.map(batch => ({ ...batch, is_full: batch.current_students >= batch.max_students, seats_left: batch.max_students - batch.current_students }));
        res.json(processedData);
    } catch (err) { res.status(500).send("Server Error"); }
});

router.get('/instructors', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM instructors ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) { res.status(500).send("Server Error"); }
});

router.get('/lessons', async (req, res) => {
    try {
        const { batch_id } = req.query;
        if (!batch_id) return res.status(400).json({ message: "Batch ID Required" });
        const lessons = await pool.query("SELECT * FROM lessons WHERE batch_id = $1 ORDER BY id ASC", [batch_id]);
        res.json(lessons.rows);
    } catch (err) { 
        if(err.code === '42P01') return res.json([]); 
        res.status(500).send("Server Error"); 
    }
});

// Get Comments for a Lesson
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

module.exports = router;
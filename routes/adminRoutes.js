const express = require('express');
const router = express.Router();
const pool = require('../db'); // database connection
const upload = require('../config/upload'); // multer config (Cloudinary)
const { cleanImagePath } = require('../utils/helpers');

// --- VERIFY PAYMENT LOGIC (အတည်ပြုခြင်းအပိုင်းကို ပိုမိုခိုင်မာအောင် ပြင်ဆင်ထားသည်) ---
const verifyPaymentHandler = async (req, res) => {
    try {
        const { id } = req.params;
        console.log(`🔄 [Verify] Processing Payment ID: ${id}`);

        // 1. Update Payment Status (RETURNING * ကို သုံး၍ အချက်အလက်များ ပြန်ယူမည်)
        const paymentUpdate = await pool.query(
            "UPDATE payments SET status = 'verified' WHERE id = $1 RETURNING *",
            [id]
        );

        if (paymentUpdate.rows.length === 0) {
            return res.status(404).json({ message: "Payment not found" });
        }

        const updatedPayment = paymentUpdate.rows[0];
        const enrollmentId = updatedPayment.enrollment_id;

        // 2. Enrollment ကို Active ဖြစ်အောင်လုပ်ပြီး ရက်ပေါင်း ၃၀ သက်တမ်းတိုးမည်
        if (enrollmentId) {
            await pool.query(
                `UPDATE enrollments SET expire_date = NOW() + INTERVAL '30 days', status = 'active' WHERE id = $1`,
                [enrollmentId]
            );
            
            // 3. ကျောင်းသားထံသို့ Notification ပို့ခြင်း
            try {
                const enrollmentInfo = await pool.query(
                    `SELECT e.student_id, b.batch_name, c.title as course_name 
                     FROM enrollments e 
                     JOIN batches b ON e.batch_id = b.id 
                     JOIN courses c ON b.course_id = c.id 
                     WHERE e.id = $1`,
                    [enrollmentId]
                );
                
                if (enrollmentInfo.rows.length > 0) {
                    const { student_id, batch_name, course_name } = enrollmentInfo.rows[0];
                    const message = `✅ Payment verified for ${course_name} (${batch_name}). Subscription active!`;
                    await pool.query(
                        "INSERT INTO notifications (student_id, message, type) VALUES ($1, $2, 'success')", 
                        [student_id, message]
                    );
                }
            } catch (notiError) { 
                console.error("⚠️ Noti Error:", notiError.message); 
            }
        }
        res.json({ message: "Payment Verified Successfully", payment: updatedPayment });
    } catch (err) {
        console.error("🔥 [Verify] ERROR:", err.message);
        res.status(500).json({ message: "Internal Server Error: " + err.message });
    }
};

// --- REJECT PAYMENT LOGIC (ငြင်းပယ်ခြင်းအပိုင်း) ---
const rejectPaymentHandler = async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        console.log(`❌ [Reject] Processing Payment ID: ${id}`);
        await client.query('BEGIN');

        // 1. Payment Status ကို rejected ပြောင်းမည်
        const paymentUpdate = await client.query(
            "UPDATE payments SET status = 'rejected' WHERE id = $1 RETURNING *", 
            [id]
        );

        if (paymentUpdate.rows.length === 0) {
             await client.query('ROLLBACK');
             return res.status(404).json({ message: "Payment not found" });
        }

        const enrollmentId = paymentUpdate.rows[0].enrollment_id;
        
        // 2. Enrollment ကို ပိတ်သိမ်းခြင်း
        if (enrollmentId) {
            await client.query(
                "UPDATE enrollments SET status = 'rejected', expire_date = (NOW() - INTERVAL '1 day') WHERE id = $1", 
                [enrollmentId]
            );
            
            const enrollmentInfo = await client.query(
                `SELECT e.student_id, b.batch_name, c.title as course_name 
                 FROM enrollments e 
                 JOIN batches b ON e.batch_id = b.id 
                 JOIN courses c ON b.course_id = c.id 
                 WHERE e.id = $1`,
                [enrollmentId]
            );

            if (enrollmentInfo.rows.length > 0) {
                const { student_id, batch_name, course_name } = enrollmentInfo.rows[0];
                const message = `❌ Payment Rejected for ${course_name} (${batch_name}). Please contact admin.`;
                await client.query(
                    "INSERT INTO notifications (student_id, message, type) VALUES ($1, $2, 'error')", 
                    [student_id, message]
                );
            }
        }
        await client.query('COMMIT');
        res.json({ message: "Payment Rejected Successfully", payment: paymentUpdate.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("🔥 [Reject DB Error]:", err.message);
        res.status(500).json({ message: err.message });
    } finally { 
        client.release(); 
    }
};

// ==========================================
// COURSE & BATCH MANAGEMENT
// ==========================================

router.post('/courses', async (req, res) => {
    try {
        const { title, description } = req.body;
        const newCourse = await pool.query(
            "INSERT INTO courses (title, description) VALUES ($1, $2) RETURNING *",
            [title, description]
        );
        res.json(newCourse.rows[0]);
    } catch (err) { res.status(500).json(err.message); }
});

router.post('/batches', async (req, res) => {
    try {
        const { id, course_id, batch_name, fees } = req.body;
        const newBatch = await pool.query(
            "INSERT INTO batches (id, course_id, batch_name, fees) VALUES ($1, $2, $3, $4) RETURNING *",
            [id, course_id, batch_name, fees]
        );
        res.json(newBatch.rows[0]);
    } catch (err) { res.status(500).json(err.message); }
});

router.get('/students', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM students ORDER BY created_at DESC");
        res.json(result.rows);
    } catch (err) { res.status(500).send("Server Error fetching students"); }
});

// --- DISCUSSION & EXAM ROUTES ---

router.get('/discussions', async (req, res) => {
    try {
        const query = `
            SELECT l.id, l.title as lesson_title, b.batch_name, c.title as course_name,
                   COUNT(co.id) as total_comments, MAX(co.created_at) as last_active
            FROM lessons l
            JOIN comments co ON l.id = co.lesson_id
            LEFT JOIN batches b ON l.batch_id = b.id::text
            LEFT JOIN courses c ON b.course_id = c.id
            GROUP BY l.id, l.title, b.batch_name, c.title
            ORDER BY last_active DESC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) { res.status(500).send("Server Error"); }
});

router.get('/comments', async (req, res) => {
    try {
        const { lesson_id } = req.query;
        const result = await pool.query("SELECT * FROM comments WHERE lesson_id = $1 ORDER BY created_at ASC", [lesson_id]);
        res.json(result.rows);
    } catch (err) { res.status(500).send("Server Error"); }
});

router.post('/comments', async (req, res) => {
    try {
        const { lesson_id, message } = req.body;
        await pool.query("INSERT INTO comments (lesson_id, user_name, user_role, message) VALUES ($1, 'Teacher (Admin)', 'admin', $2)", [lesson_id, message]);
        res.json({ message: "Reply added" });
    } catch (err) { res.status(500).send("Server Error"); }
});

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

router.post('/exams', async (req, res) => {
    try {
        const { enrollment_id, exam_title, marks_obtained, total_marks, grade } = req.body;
        const newExam = await pool.query(`INSERT INTO exam_results (enrollment_id, exam_title, marks_obtained, total_marks, grade) VALUES ($1, $2, $3, $4, $5) RETURNING *`, [enrollment_id, exam_title, marks_obtained, total_marks, grade]);
        res.json(newExam.rows[0]);
    } catch (err) { res.status(500).json({ message: "Server Error: " + err.message }); }
});

router.delete('/exams/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM exam_results WHERE id = $1", [req.params.id]);
        res.json({ message: "Deleted Successfully" });
    } catch (err) { res.status(500).send("Server Error"); }
});

// --- PAYMENT & STATS ROUTES ---

// (New Mapping) PUT /admin/payments/:id အတွက် Logic ခွဲခြားခြင်း
router.put('/payments/:id', async (req, res) => {
    const { status } = req.body;
    if (status === 'verified') return verifyPaymentHandler(req, res);
    if (status === 'rejected') return rejectPaymentHandler(req, res);
    res.status(400).json({ message: "Invalid status provided" });
});

// လက်ရှိ Verify Payment tab တွင် ခလုတ်နှိပ်၍မရပါက ဤအောက်ပါ Route ဟောင်း ၂ ခုကိုပါ တစ်ပါတည်း ထားရှိပေးထားသည်
router.put('/verify-payment/:id', verifyPaymentHandler);
router.put('/reject-payment/:id', rejectPaymentHandler);

router.get('/stats', async (req, res) => {
    try {
        const studentCount = await pool.query("SELECT COUNT(*) FROM students");
        const incomeTotal = await pool.query("SELECT SUM(amount) FROM payments WHERE status = 'verified'");
        res.json({ total_students: studentCount.rows[0].count, total_income: incomeTotal.rows[0].sum || 0 });
    } catch (err) { res.status(500).send("Server Error"); }
});

router.get('/payments', async (req, res) => {
    try {
        const query = `
          SELECT p.id, p.amount, p.payment_method, p.payment_date, p.status, p.receipt_image, p.transaction_id,
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

router.post('/lessons', upload.single('video_file'), async (req, res) => {
    try {
        const { batch_id, title, description } = req.body;
        if (!req.file) return res.status(400).json({ message: "No Video File" });
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

// --- DATABASE FIX ROUTE (Run This if still issues) ---
router.get('/fix-database', async (req, res) => {
    try {
        await pool.query("ALTER TABLE payments ADD COLUMN IF NOT EXISTS transaction_id VARCHAR(50)");
        res.send("<h1 style='color:green;'>✅ Database Updated Successfully!</h1>");
    } catch (err) {
        res.status(500).send("❌ Error: " + err.message);
    }
});

module.exports = router;
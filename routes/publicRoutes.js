const express = require('express');
const router = express.Router();
const pool = require('../db'); // Database Connection
const bcrypt = require('bcryptjs'); // Password Hashing
const multer = require('multer'); // Image Upload
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');

// --- Cloudinary Config (Environment Variables မှ ယူပါမည်) ---
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Multer Setup (Memory Storage)
const upload = multer({ storage: multer.memoryStorage() });

// --- Helper Function: Cloudinary Upload ---
const uploadToCloudinary = (buffer) => {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            { folder: "students" },
            (error, result) => {
                if (result) resolve(result.secure_url);
                else reject(error);
            }
        );
        streamifier.createReadStream(buffer).pipe(uploadStream);
    });
};

// 1. GET Instructors (ဆရာများစာရင်း)
router.get('/instructors', async (req, res) => {
    try {
        // Sample Data သို့မဟုတ် DB ထဲကဆွဲထုတ်မည်
        res.json([
            { id: 1, name: "Tr. Myo", role: "Senior Developer", image: "https://via.placeholder.com/150" },
            { id: 2, name: "Tr. Hla", role: "Database Expert", image: "https://via.placeholder.com/150" }
        ]);
    } catch (err) {
        console.error("🔥 Error in GET /instructors:", err.message);
        res.status(500).json({ message: "Server Error fetching instructors" });
    }
});

// 2. GET Promo Courses (ရှေ့ဆုံးမှာပြမည့် သင်တန်းများ)
router.get('/promo-courses', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM courses LIMIT 3");
        res.json(result.rows);
    } catch (err) {
        console.error("🔥 Error in GET /promo-courses:", err.message);
        res.status(500).json({ message: "Server Error fetching courses" });
    }
});

// ============================================
// 3. GET All Batches (Payment Dropdown အတွက်)
// ============================================
router.get('/batches', async (req, res) => {
    try {
        // Batch နဲ့ Course ကို တွဲပြီး ဆွဲထုတ်ပါမယ် (Dropdown မှာပြဖို့)
        const result = await pool.query(`
            SELECT b.id, b.batch_name, b.fees, c.title as course_title 
            FROM batches b
            JOIN courses c ON b.course_id = c.id
        `);
        res.json(result.rows);
    } catch (err) {
        console.error("🔥 Error fetching batches:", err.message);
        res.status(500).json("Server Error");
    }
});

// 4. POST Register (ကျောင်းသားအသစ် စာရင်းသွင်းခြင်း)
router.post('/register', upload.single('profileImage'), async (req, res) => {
    console.log("➡️ Register Request Received:", req.body); // Debugging

    const { name, phone, password, address } = req.body;

    try {
        // ၁။ ဖုန်းနံပါတ် ရှိ၊ မရှိ စစ်ခြင်း
        const userCheck = await pool.query("SELECT * FROM students WHERE phone_primary = $1", [phone]);
        if (userCheck.rows.length > 0) {
            return res.status(400).json({ message: "This phone number is already registered!" });
        }

        // ၂။ Password ကို Hash လုပ်ခြင်း (လုံခြုံရေး)
        const hashedPassword = await bcrypt.hash(password, 10);

        // ၃။ ပုံပါလာရင် Cloudinary တင်၊ မပါရင် Default ပုံထား
        let profileImageUrl = "https://via.placeholder.com/150";
        if (req.file) {
            console.log("📸 Uploading image to Cloudinary...");
            try {
                profileImageUrl = await uploadToCloudinary(req.file.buffer);
            } catch (uploadError) {
                console.error("⚠️ Cloudinary Upload Failed:", uploadError);
                // ပုံတင်မရလည်း Register ဆက်လုပ်ပေးပါမယ် (Error မတက်စေရန်)
            }
        }

        // ၄။ Database ထဲ ထည့်ခြင်း
        const newUser = await pool.query(
            `INSERT INTO students (name, phone_primary, password, address, profile_image) 
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [name, phone, hashedPassword, address, profileImageUrl]
        );

        console.log("✅ New Student Registered:", newUser.rows[0].name);
        res.status(201).json({ message: "Registration Successful!", user: newUser.rows[0] });

    } catch (err) {
        console.error("🔥 Error in POST /register:", err); 
        res.status(500).json({ message: "Server Error: " + err.message });
    }
});

// 5. POST Login (အကောင့်ဝင်ခြင်း)
router.post('/login', async (req, res) => {
    const { phone, password } = req.body;
    try {
        const userResult = await pool.query("SELECT * FROM students WHERE phone_primary = $1", [phone]);

        if (userResult.rows.length === 0) {
            return res.status(400).json({ message: "Phone number not found!" });
        }

        const user = userResult.rows[0];
        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            return res.status(400).json({ message: "Invalid Password!" });
        }

        res.json({ message: "Login Successful", user: { id: user.id, name: user.name, role: "student" } });

    } catch (err) {
        console.error("🔥 Error in POST /login:", err.message);
        res.status(500).json({ message: "Server Error during login" });
    }
});

// ============================================
// 🆕 6. POST Payment Upload (ငွေလွှဲပြေစာ တင်ခြင်း - Updated with Transaction ID)
// ============================================
router.post('/payment-upload', upload.single('receipt'), async (req, res) => {
    try {
        console.log("➡️ Payment Request:", req.body);
        
        // transaction_id ကို Frontend မှ လက်ခံရယူခြင်း
        const { student_id, batch_id, amount, payment_method, transaction_id } = req.body;

        // ၁။ Enrollment အရင်လုပ်ပါ (Pending အနေနဲ့)
        const enrollment = await pool.query(
            "INSERT INTO enrollments (student_id, batch_id, status) VALUES ($1, $2, 'pending') RETURNING id",
            [student_id, batch_id]
        );
        const enrollment_id = enrollment.rows[0].id;

        // ၂။ Receipt ပုံ Cloudinary တင်ပါ
        let receiptUrl = "";
        if (req.file) {
            receiptUrl = await uploadToCloudinary(req.file.buffer);
        }

        // ၃။ Payment Table မှာ မှတ်တမ်းတင်ပါ (transaction_id ပါ ထည့်သွင်းခြင်း)
        await pool.query(
            `INSERT INTO payments (enrollment_id, amount, payment_method, receipt_image, status, transaction_id) 
             VALUES ($1, $2, $3, $4, 'pending', $5)`,
            [enrollment_id, amount, payment_method, receiptUrl, transaction_id]
        );

        res.json({ message: "Payment Submitted Successfully!" });

    } catch (err) {
        console.error("🔥 Payment Error:", err.message);
        res.status(500).json({ message: "Payment Upload Failed: " + err.message });
    }
});

module.exports = router;
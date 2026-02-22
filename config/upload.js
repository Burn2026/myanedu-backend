const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

// ✅ .env ဖိုင်ထဲက Key များကို လှမ်းခေါ်သုံးခြင်း (process.env ကို အသုံးပြုထားသည်)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'myanedu_lessons', // Cloudinary ထဲက Folder နာမည်
    resource_type: 'auto',     // Video နှင့် Image အားလုံးကို လက်ခံရန်
    allowed_formats: ['mp4', 'mkv', 'mov', 'avi', 'jpg', 'jpeg', 'png'], // ✅ .mov ကိုပါ ခွင့်ပြုပေးထားသည်
  },
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 } // ✅ 100MB Limit သတ်မှတ်ထားသည်
});

module.exports = upload;
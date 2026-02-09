const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

cloudinary.config({
  cloud_name: 'domur49qq', // Cloudinary Dashboard မှ နာမည်ထည့်ပါ
  api_key: '865224348384822',       // Cloudinary Dashboard မှ Key ထည့်ပါ
  api_secret: 'OOzhK2jx8iyGLff7Bu7CBqNEgig'  // Cloudinary Dashboard မှ Secret ထည့်ပါ
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'myanedu_uploads', // Cloudinary ပေါ်တွင် သိမ်းမည့် Folder အမည်
    allowed_formats: ['jpg', 'png', 'jpeg', 'mp4', 'mkv'],
    resource_type: 'auto' // Video ရော Image ပါ လက်ခံရန်
  },
});

const upload = multer({ storage: storage });

module.exports = upload;
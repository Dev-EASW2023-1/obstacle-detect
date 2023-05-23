require('dotenv').config();

const express = require('express');
const multer = require('multer');
const AWS = require('aws-sdk');
const Jimp = require('jimp');
const fs = require('fs');

const app = express();

AWS.config.update({
	region: process.env.AWS_REGION,
	accessKeyId: process.env.AWS_ACCESS_KEY_ID,
	secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

const s3 = new AWS.S3();

const upload = multer({ dest: 'uploads/' });

app.post('/upload', upload.single('image'), async (req, res) => {
	const fileContent = fs.readFileSync(req.file.path);
	const params = {
	  Bucket: process.env.AWS_S3_BUCKET_NAME,
	  Key: req.file.originalname,
	  Body: fileContent
	};
	const data = await s3.upload(params).promise();
	res.json({ imageName: req.file.originalname });
  });

app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.listen(3000, () => console.log('Server running on port 3000'));
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
const rekognition = new AWS.Rekognition();

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

app.get('/analyze/:imageName', async (req, res) => {
	const params = {
	  Image: {
		S3Object: {
		  Bucket: process.env.AWS_S3_BUCKET_NAME,
		  Name: req.params.imageName
		}
	  },
	  MaxLabels: 10
	};
	const data = await rekognition.detectLabels(params).promise();
	let image = await Jimp.read(
	  `https://${process.env.AWS_S3_BUCKET_NAME}.s3.amazonaws.com/${params.Image.S3Object.Name}`
	);
	const borderThickness = 3;
  
	data.Labels.forEach(label => {
	  label.Instances.forEach(instance => {
		const box = instance.BoundingBox;
		const height = image.bitmap.height;
		const width = image.bitmap.width;
  
		const x1 = Math.floor(box.Left * width);
		const y1 = Math.floor(box.Top * height);
		const boxWidth = Math.floor(box.Width * width);
		const boxHeight = Math.floor(box.Height * height);
  
		image.scan(x1, y1, boxWidth, borderThickness, function (x, y, idx) { // Top
		  this.bitmap.data[idx] = 255; // R
		  this.bitmap.data[idx + 1] = 0; // G
		  this.bitmap.data[idx + 2] = 0; // B
		});
		image.scan(x1, y1, borderThickness, boxHeight, function (x, y, idx) { // Left
		  this.bitmap.data[idx] = 255; // R
		  this.bitmap.data[idx + 1] = 0; // G
		  this.bitmap.data[idx + 2] = 0; // B
		});
		image.scan(x1, y1 + boxHeight - borderThickness, boxWidth, borderThickness, function (x, y, idx) { // Bottom
		  this.bitmap.data[idx] = 255; // R
		  this.bitmap.data[idx + 1] = 0; // G
		  this.bitmap.data[idx + 2] = 0; // B
		});
		image.scan(x1 + boxWidth - borderThickness, y1, borderThickness, boxHeight, function (x, y, idx) { // Right
		  this.bitmap.data[idx] = 255; // R
		  this.bitmap.data[idx + 1] = 0; // G
		  this.bitmap.data[idx + 2] = 0; // B
		});
	  });
	});

	const maxDimension = 1000;
  if (image.bitmap.width > maxDimension || image.bitmap.height > maxDimension) {
    if (image.bitmap.width > image.bitmap.height)
      image = image.resize(maxDimension, Jimp.AUTO);
    else 
      image = image.resize(Jimp.AUTO, maxDimension);
  }

	const buffer = await image.getBufferAsync(Jimp.MIME_PNG);
	res.set('Content-Type', 'image/png');
	res.send(buffer);
});

app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.listen(3000, () => console.log('Server running on port 3000'));
require('dotenv').config();

const express = require('express');
const multer = require('multer');
const AWS = require('aws-sdk');
const Jimp = require('jimp');
const fs = require('fs');

const app = express();
const s3 = new AWS.S3();
const rekognition = new AWS.Rekognition();
const upload = multer({ dest: 'uploads/' });
let font;

Jimp.loadFont(Jimp.FONT_SANS_32_BLACK).then(loadedFont => font = loadedFont);

AWS.config.update({
	region: process.env.AWS_REGION,
	accessKeyId: process.env.AWS_ACCESS_KEY_ID,
	secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

// S3 utilities
const createS3Params = (fileName, fileContent) => {
	return {
		Bucket: process.env.AWS_S3_BUCKET_NAME,
		Key: fileName,
		Body: fileContent
	};
};

app.post('/upload', upload.single('image'), async (req, res) => {
    try {
        fs.readFile(req.file.path, async (err, fileContent) => {
            if (err) {
                console.error(`Error reading file: ${err}`);
                res.status(500).send('Error reading file');
            } else {
                const params = createS3Params(req.file.originalname, fileContent);
                await s3.upload(params).promise();

                fs.unlink(req.file.path, (err) => {
                    if (err) 
                        console.error(`Error deleting file: ${err}`);
                });

                res.json({ imageName: req.file.originalname });
            }
        });
    } catch (error) {
        fs.unlink(req.file.path, (err) => {});
        console.error(`Error in /upload: ${error}`);
        res.status(500).send('Error uploading image');
    }
});



// Rekognition utilities
const createRekognitionParams = (imageName) => {
	return {
		Image: {
			S3Object: {
				Bucket: process.env.AWS_S3_BUCKET_NAME,
				Name: imageName
			}
		},
		MaxLabels: 10
	};
};

app.get('/analyze/:imageName', async (req, res) => {
	try {
		const showObjects = req.query.showObjects === 'true';
		const params = createRekognitionParams(req.params.imageName);
		const data = await rekognition.detectLabels(params).promise();
		const image = await Jimp.read(
		  `https://${process.env.AWS_S3_BUCKET_NAME}.s3.amazonaws.com/${params.Image.S3Object.Name}`
		);

		drawBoundingBoxes(image, data.Labels, showObjects);
		resizeImage(image);
		const buffer = await image.getBufferAsync(Jimp.MIME_PNG);

		res.set('Content-Type', 'image/png');
		res.send(buffer);
	} catch (error) {
		console.error(`Error in /analyze: ${error}`);
    	res.status(500).send('Error analyzing image');
	}
});

// Image manipulation utilities
const getBoxDimensions = (image, box) => {
    const height = image.bitmap.height;
    const width = image.bitmap.width;

    const x1 = Math.floor(box.Left * width);
    const y1 = Math.floor(box.Top * height);
    const boxWidth = Math.floor(box.Width * width);
    const boxHeight = Math.floor(box.Height * height);
    const centerX = x1 + boxWidth / 2;
    const centerY = y1 + boxHeight / 2;

    return [x1, y1, boxWidth, boxHeight, centerX, centerY];
};

const checkCenterRange = (centerX, centerY, width, height) => {
    const centerXRange = [width * parseFloat(process.env.CENTER_X_RANGE_START), width * parseFloat(process.env.CENTER_X_RANGE_END)];
    const centerYRange = [height * parseFloat(process.env.CENTER_Y_RANGE_START), height * parseFloat(process.env.CENTER_Y_RANGE_END)];

    return (centerX >= centerXRange[0] && centerX <= centerXRange[1] &&
            centerY >= centerYRange[0] && centerY <= centerYRange[1]);
};

const drawBoundingBox = (image, x1, y1, boxWidth, boxHeight, name, confidence, showObjects) => {

    const borderThickness = parseInt(process.env.BORDER_THICKNESS);
    const drawLine = (x, y, width, height) => {
        image.scan(x, y, width, height, function (dx, dy, idx) {
            this.bitmap.data[idx] = parseInt(process.env.BORDER_COLOR_RED);
            this.bitmap.data[idx + 1] = parseInt(process.env.BORDER_COLOR_GREEN);
            this.bitmap.data[idx + 2] = parseInt(process.env.BORDER_COLOR_BLUE);
        });
    };

    drawLine(x1, y1, boxWidth, borderThickness); // Top
    drawLine(x1, y1, borderThickness, boxHeight); // Left
    drawLine(x1, y1 + boxHeight - borderThickness, boxWidth, borderThickness); // Bottom
    drawLine(x1 + boxWidth - borderThickness, y1, borderThickness, boxHeight); // Right

    if(showObjects)
    {
        const fontSize = 32; 
        const padding = 2;  
        const backgroundHeight = fontSize * 2 + padding * 2;  
        const textY = y1 + boxHeight - backgroundHeight - 10;  

        const textNameWidth = name.length * fontSize * 0.6;  
        const textConfidenceWidth = confidence.toFixed(2).length * fontSize * 0.6;
        const backgroundWidth = Math.max(textNameWidth, textConfidenceWidth) + padding * 2; 

        image.scan(x1 + 10, textY, backgroundWidth, backgroundHeight, function (x, y, idx) {
            this.bitmap.data[idx] = 255;  // R
            this.bitmap.data[idx + 1] = 255;  // G
            this.bitmap.data[idx + 2] = 255;  // B
            this.bitmap.data[idx + 3] = 255;  // A
        });

        image.print(font, x1 + 10 + padding, textY + padding, name);
        image.print(font, x1 + 10 + padding, textY + fontSize + padding, confidence.toFixed(2));
    }
};

const drawBoundingBoxes = (image, labels, showObjects) => {
    labels.forEach(label => {
        label.Instances.forEach(instance => {
            const [x1, y1, boxWidth, boxHeight, centerX, centerY] = getBoxDimensions(image, instance.BoundingBox);

            if (checkCenterRange(centerX, centerY, image.bitmap.width, image.bitmap.height)) 
                drawBoundingBox(image, x1, y1, boxWidth, boxHeight, label.Name, label.Confidence, showObjects);
        });
    });
};

const resizeImage = (image) => {
    const maxDimension = process.env.MAX_IMAGE_SIZE;
    if (image.bitmap.width > maxDimension || image.bitmap.height > maxDimension) {
        image.bitmap.width > image.bitmap.height ?
        image.resize(maxDimension, Jimp.AUTO) :
        image.resize(Jimp.AUTO, maxDimension);
    }
};

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

app.listen(3000, () => console.log('Server running on port 3000'));

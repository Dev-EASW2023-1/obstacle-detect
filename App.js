require('dotenv').config();

const express = require('express');
const multer = require('multer');
const AWS = require('aws-sdk');
const Jimp = require('jimp');
const fs = require('fs');
const e = require('express');

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

// after analying image, store labelName in this variable
let labelName = undefined;

app.post('/upload', upload.single('image'), async (req, res) => {
    try {
        if(req.file !== undefined){
            fs.readFile(req.file.path, async (err, fileContent) => {
                if (err) {
                    console.error(`Error reading file: ${err}`);
                    res.status(500).json({ error:'Error reading file'});
                } else {
                    const params = createS3Params(req.file.originalname, fileContent);
                    await s3.upload(params).promise();
    
                    fs.unlink(req.file.path, (err) => {
                        if (err) 
                            console.error(`Error deleting file: ${err}`);
                    });
    
                    res.json({ imageName: req.file.originalname,  message: 'success'});
                }
            });
        } else {
            res.status(500).json({ error:'No files chosen'});
        }
    } catch (error) {
        fs.unlink(req.file.path, (err) => {});
        console.error(`Error in /upload: ${error}`);
        res.status(500).json({ error:'Error uploading image'});
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
        let array = [];

        // Adding the size of the label's BoundingBox to Array is to compare comparing the size of the label's BoundingBox.
        data.Labels.forEach((label) => {
            if(label.Instances.length > 0){
                label.Instances.forEach((instance) => {
                    array.push({"name" : `${label.Name}`, "size" : `${instance.BoundingBox.Width + instance.BoundingBox.Height}`});
                });
            }
        }); 

        // find max size label
        if(array.length !== 0) {
            const importantLabel  = array.reduce((acc, cur) => {
                return acc.size > cur.size ? acc : cur;
            });
            labelName = `전방에 ${importantLabel.name} 있습니다.`;
        } else {
            labelName = `전방에 아무 것도 없습니다.`;
        }

        console.log(array);

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
    	res.status(500).json({ error:'Error analyzing image'});
	}
});

app.get('/tts', function (req, res) {
    if(labelName !== undefined) {
        const api_url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_TTS_API_KEY}`;
        const data = {
            input: {
                text: labelName
            },
            voice: {
                languageCode: "ko-KR",
                name: "ko-KR-Neural2-c",
                ssmlGender: "MALE"
            },
            audioConfig: {
                audioEncoding: "MP3"
            },
        };
        const options = {
            headers: {
                "content-type": "application/json; charset=UTF-8",
            },
            body: JSON.stringify(data),
            method: "POST"
        };
        fetch(api_url, options)
        .then((response) => {
            if (!response.ok) {
                console.log(response);
                throw new Error("Error with Text to Speech conversion");
            } 
            response.json().then((data) => {
                const audioContent = data.audioContent; // base64
                const audioBuffer = Buffer.from(audioContent, "base64");
                console.log("오디오 변환 성공");
                res.send(audioBuffer);
            });
        })
        .catch((error) => {
            console.error(`Error in /tts: ${error}`);
            res.status(500).json({ error:'Error converting text to speech'});
        });
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

app.listen(3000);

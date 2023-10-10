const AWS = require("aws-sdk");
const fastcsv = require("fast-csv");
const HashMap = require('hashmap');
const s3 = new AWS.S3({
    signatureVersion: "v4",
});

const ssm = new AWS.SSM({ region: process.env.AWS_REGION });

const { BUCKET_NAME, WINE_POS_BASE, UPLOAD_BUCKET_NAME } = process.env;

/* 
    **********************************************************
        Main Handler for the Trigger
    **********************************************************
*/

exports.handler = async (event) => {
    // Dump the Event for Info purpose
    if (!event) throw new Error("Event not found");
    console.log("Received event {}", JSON.stringify(event, 3));

    const bucketName = event.Records[0].s3.bucket.name;
    //Get object key from event
    const key = decodeURIComponent(
        event.Records[0].s3.object.key.replace(/\+/g, " ")
    );
    const eventName = event.Records[0].eventName;
    let objectKey = key.split("\/");

    var fileName;
    var userName;
    var prefix;
    if (objectKey.length > 1) {
        prefix = objectKey[0];
        userName = objectKey[1];
        fileName = objectKey[2];
    }

    if (prefix != "userUploads") {
        //only process if file iS in userUploads - Temporary solution for WinePos.  TODO Need to change
        // TODO:          
        console.log('not processing as this is not for userUploads Prefix:', prefix);
        return;
    }

    // Got the Trigger from Wrong Bucket.  Ignore
    if (bucketName != BUCKET_NAME) {
        console.error("Wrong bucket", bucketName);
        return;
    }

    // get Mapping Data for WinePoS
    console.log("Getting Mapping Data");
    let mapRecords = await getMappingData(bucketName);

    // Read PnA Records from WinePoS file.
    console.log("Getting PnA Records");
    let pnaRecords = await getWinePoSPnARecs(key, bucketName);

    // Map the records using Map file.
    console.log("MAPPING");
    let mappedRecords = [];
    pnaRecords.forEach(rec => {
        let matchedRec = mapRecords.get(rec.item_num)
        if (matchedRec)
        {
            let newRec = {
                "productId": matchedRec.id,
                "upc": matchedRec.upc,
                "storeItemId": rec.item_num,
                "prodName": rec.descr,
                "price": rec.unit_price,
                "salePrice": rec.web_unit_sale_price,
                "totalQty": rec.on_hand,
                "altUPC1": rec.n_comparable_data,
                "altUPC2": rec.full_barcode
              };
            mappedRecords.push(newRec);    
        }
    });

    // "storeCode": rec.STORECODE
    // Upload the Records to S3 bucket under merchant and Store 
    // So next trigger will pick it up
    console.log("***  Map Records- Show")
    console.log(mappedRecords[0]);
    console.log("**** PNA Records");
    console.log(pnaRecords[0]);
    await writeCsv(mappedRecords, fileName);

    const response1 = {
        statusCode: 200,
        body: JSON.stringify({"Message": "Success"})
    };

    return response1;
};

/* 
    **********************************************************
        Load Mapping file from S3 Bucket for WinePos Data
    **********************************************************
*/
const getMappingData = async(bucketName) => {

    //get product Mapping data
    var mappingKey = "productmappings/WinePoS/productmappings.csv";
    var getMappingParams = { Bucket: bucketName, Key: mappingKey }
    var map = new HashMap();

    const s3MappingStream = s3.getObject(getMappingParams).createReadStream();

    let mappingParserFcn = new Promise((resolve, reject) => {
        const parser = fastcsv
            .parseStream(s3MappingStream, { headers: true })
            .on("data", function (data) {
                map.set(data.item_num, data);
            })
            .on("end", function () {
                resolve("csv parse process finished for mapping file");
            })
            .on("error", function (error) {
                console.log(error);
                reject("csv parse process failed for mapping file");
            });
    });

    try {
        await mappingParserFcn;

    } catch (error) {
        console.log("Get Error: ", error);
    }
    return map;
}

/* 
    **********************************************************
        Read PnA Records from S3 Bucket for WinePos Data
    **********************************************************
*/
const getWinePoSPnARecs = async(fileKey, bucketName) =>
{
    var getParams = { Bucket: bucketName, Key: fileKey };

    const response = await s3.getObject(getParams).promise() // await the promise
    const fileContent = response.Body.toString('utf-8'); // can also do 'base64' here if desired 
    var lines = fileContent.split('\n');
    
    let splitter = ",";
    if(fileKey.endsWith(".csv"))
    {
        splitter = ","
    }

    let pnaRecs = [];
    console.log(lines[0]);
    lines.forEach(row => {
        let fields = row.split(splitter);
        pnaRecs.push(
            {
                "item_num" : fields[0],
                "descr" : fields[1],
                "vintage" : fields[2],
                "size_descr" : fields[4],
                "case_qty" : fields[6],
                "unit_price": fields[7],
                "shlf_price" : fields[8],
                "pack_qty" : fields[9],
                "wc_shlfprce" : fields[10],
                "on_hand" : fields[11] * 1,
                "n_comparable_data" : fields[12],
                "tax_flag": fields[18],
                "sale_price" : fields[19],
                "case_sale_price" : fields[20],
                "invoice_cost_bottle" : fields[38],
                "sale_type" : fields[39],
                "pack_sale_price" : fields[40],
                "web_unit_sale_price" : fields[48],
                "full_barcode" : fields[62]
            }
        );
    });
    return pnaRecs;
}


/* 
    **********************************************************
*   Write CSV file
    **********************************************************
*/
const writeCsv = async (items, fileName) => 
{
    
  // get List of Stores to process from the Parameter Store
  const keyParams = {
    Name: WINE_POS_BASE + "/storeList",
    WithDecryption: true,
  };

  const keyParameter = await ssm.getParameter(keyParams).promise();
  const keyParms = JSON.parse(keyParameter.Parameter.Value);
  const storeMapping = keyParms["storeMapping"];
  const storeDetails = storeMapping[fileName];
  console.log("*****")
  console.log(storeMapping);
  console.log("Store Details "+ fileName);
  console.log(storeDetails);
  if (!storeDetails) {
    console.log("Store Mapping Not Found" + fileName + " ");
    return;
  }

    // const s3KeyPrefix = "StorePnAUpdates/" + storeDetails.merchantId + "/";
    const s3KeyPrefix = "StorePnAUpdates/" ;
    const storeId = storeDetails["storeId"];
    const replacer = (key, value) => value === null ? '' : value; // specify how you want to handle null values here
    const header = Object.keys(items[0]);
    let csv = items.map(row => header.map(fieldName => JSON.stringify(row[fieldName], replacer)).join(','));
    csv.unshift(header.join(','));
    csv = csv.join('\r\n');

    const s3UploadParams = {
        Bucket: UPLOAD_BUCKET_NAME,
        Key: s3KeyPrefix + storeId,
        Body: JSON.stringify(items)
      };
      let uploadResponse = await s3.upload(s3UploadParams).promise();
      console.log(uploadResponse);
      console.log("PnA FIle hasbeen uploaded to S3 Bucket" );
}
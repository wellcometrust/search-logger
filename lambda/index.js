const elasticsearch = require("elasticsearch");

let esClient;
function setEsClient(credentials) {
  esClient = new elasticsearch.Client({
    host: credentials.url,
    httpAuth: `${credentials.username}:${credentials.password}`
  });
}

const AWS = require("aws-sdk");
const region = "eu-west-1";
const secretName = "prod/SearchLogger/es_details";
const secretsManager = new AWS.SecretsManager({
  region: region
});
const validServices = [
  "search_relevance_implicit",
  "search_relevance_explicit"
];

function processEvent(event, context, callback) {
  const body = event.Records.map(function(record) {
    const payload = new Buffer(record.kinesis.data, "base64").toString("utf-8");
    try {
      const json = JSON.parse(payload);
      const network =
        json.context.ip === "195.143.129.132"
          ? "StaffCorporateDevices"
          : json.context.ip === "195.143.129.232"
          ? "Wellcome-WiFi"
          : null;

      // If we don't have a service, skip over it
      const service = json.properties.service;
      const validService = validServices.indexOf(service) !== -1;

      const document = {
        event: json.event,
        anonymousId: json.anonymousId,
        timestamp: json.timestamp,
        network,
        toggles: json.properties.toggles,
        data: json.properties.data
      };

      if (validService) {
        console.info(`Creating record for valid service: ${service}`);
        return [
          {
            index: {
              _index: service,
              _type: "_doc",
              _id: json.messageId
            }
          },
          document
        ];
      } else {
        console.error(
          `Error: Not creating record for invalid service: ${service}`,
          payload
        );
        return [];
      }
    } catch (e) {
      console.error(e, payload);
      return;
    }
  })
    .filter(Boolean)
    .reduce(function(acc, tuple) {
      return acc.concat(tuple);
    }, []);

  // Get only uniques
  const services = body
    .map(b => b.index && b.index._index)
    .filter(Boolean)
    .filter((service, i, arr) => arr.indexOf(service) === i)
    .join(", ");

  if (body.length > 0) {
    esClient.bulk({ body: body }, function(err, resp) {
      if (err) {
        console.error(err);
      } else {
        if (resp.errors === true) {
          console.log(
            "Error sending bulk to Elastic: ",
            JSON.stringify(resp, null, 2)
          );
        } else {
          console.log(
            `Success on services: ${services} with ${body.length / 2} records`
          );
        }
      }
    });
  }
}

exports.handler = function(event, context) {
  if (esClient) {
    processEvent(event, context);
  } else {
    secretsManager.getSecretValue({ SecretId: secretName }, function(
      err,
      data
    ) {
      if (err) {
        console.info("Secrets Manager error");
        console.error(err);
      } else {
        console.info("Secrets Manager success");
        try {
          const esCredentials = JSON.parse(data.SecretString);
          setEsClient(esCredentials);
          processEvent(event, context);
        } catch (e) {
          console.error(
            "Secrets Manager error: `SecretString` was not a valid JSON string"
          );
        }
      }
    });
  }
};

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as dotenv from 'dotenv';
import * as express from "express";
import * as defaultServer from "./default-server";
dotenv.config();

const https = require("https");
const fs = require("fs");

defaultServer.start(function (err: Error, app: express.Express) {
  if (err) {
    throw err;
  }

  const httpsEnabled: boolean = Boolean(process.env.HTTPS) || false;
  const defaultPort: number = httpsEnabled ? 8443 : 3010;

  const port: number = Number(process.env.API_PORT) || Number(process.env.PORT) || defaultPort;
  let server: any;

  if (httpsEnabled) {
    const options = {
      key: fs.readFileSync("./certs/cert.key", "utf8"),
      cert: fs.readFileSync("./certs/cert.crt", "utf8"),
    };

    server = https.createServer(options, app).listen(port, function () {
      console.log("API host listening at https://localhost:" + port);
    });
  } else {
    server = app.listen(port, function () {
      console.log("API host listening at http://localhost:" + port);
    });
  }

  server.setTimeout(0);
});

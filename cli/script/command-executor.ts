// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import AccountManager = require("./management-sdk");
const childProcess = require("child_process");
import * as chalk from "chalk";
import * as fs from "fs";
import * as moment from "moment";
import * as os from "os";
import * as path from "path";
import * as Q from "q";
import * as semver from "semver";
import {
  AccessKey,
  Account,
  App,
  CodePushError,
  CollaboratorMap,
  CollaboratorProperties,
  Deployment,
  DeploymentMetrics,
  Headers,
  Package,
  PackageInfo,
  Session,
  UpdateMetrics,
} from "../script/types";
import * as cli from "../script/types/cli";
import debugCommand from "./commands/debug";
import {
  getAndroidHermesEnabled,
  getiOSHermesEnabled,
  isValidVersion,
  runHermesEmitBinaryCommand
} from "./react-native-utils";
import sign from "./sign";
import {
  fileDoesNotExistOrIsDirectory,
  fileExists,
  isBinaryOrZip
} from "./utils/file-utils";
const g2js = require("gradle-to-js/lib/parser");
const opener = require("opener");
const plist = require("plist");
const progress = require("progress");
const prompt = require("prompt");
const rimraf = require("rimraf");
const Table = require("cli-table");
const which = require("which");
import wordwrap = require("wordwrap");
const xcode = require("xcode");

const configFilePath: string = path.join(process.env.LOCALAPPDATA || process.env.HOME, ".code-push.config");
const emailValidator = require("email-validator");
const packageJson = require("../../package.json");
const parseXml = Q.denodeify(require("xml2js").parseString);
import Promise = Q.Promise;
const properties = require("properties");

const CLI_HEADERS: Headers = {
  "X-CodePush-CLI-Version": packageJson.version,
};

/** Deprecated */
interface ILegacyLoginConnectionInfo {
  accessKeyName: string;
}

interface ILoginConnectionInfo {
  accessKey: string;
  customServerUrl?: string; // A custom serverUrl for internal debugging purposes
  preserveAccessKeyOnLogout?: boolean;
}

export interface UpdateMetricsWithTotalActive extends UpdateMetrics {
  totalActive: number;
}

export interface PackageWithMetrics {
  metrics?: UpdateMetricsWithTotalActive;
}

export const log = (message: string | any): void => console.log(message);
export let sdk: AccountManager;
/**
 * - 새로운 프로세스를 생성합니다.
 * - 새로운 명령어나 프로그램을 별도의 프로세스로 실행합니다.
 */
export const spawn = childProcess.spawn;
export const execSync = childProcess.execSync;

let connectionInfo: ILoginConnectionInfo;

export const confirm = (message: string = "Are you sure?"): Promise<boolean> => {
  message += " (y/N):";
  return Promise<boolean>((resolve, reject, notify): void => {
    prompt.message = "";
    prompt.delimiter = "";

    prompt.start();

    prompt.get(
      {
        properties: {
          response: {
            description: chalk.cyan(message),
          },
        },
      },
      (err: any, result: any): void => {
        const accepted = result.response && result.response.toLowerCase() === "y";
        const rejected = !result.response || result.response.toLowerCase() === "n";

        if (accepted) {
          resolve(true);
        } else {
          if (!rejected) {
            console.log('Invalid response: "' + result.response + '"');
          }
          resolve(false);
        }
      }
    );
  });
};

function accessKeyAdd(command: cli.IAccessKeyAddCommand): Promise<void> {
  return sdk.addAccessKey(command.name, command.ttl).then((accessKey: AccessKey) => {
    log(`Successfully created the "${command.name}" access key: ${accessKey.key}`);
    log("Make sure to save this key value somewhere safe, since you won't be able to view it from the CLI again!");
  });
}

function accessKeyPatch(command: cli.IAccessKeyPatchCommand): Promise<void> {
  const willUpdateName: boolean = isCommandOptionSpecified(command.newName) && command.oldName !== command.newName;
  const willUpdateTtl: boolean = isCommandOptionSpecified(command.ttl);

  if (!willUpdateName && !willUpdateTtl) {
    throw new Error("A new name and/or TTL must be provided.");
  }

  return sdk.patchAccessKey(command.oldName, command.newName, command.ttl).then((accessKey: AccessKey) => {
    let logMessage: string = "Successfully ";
    if (willUpdateName) {
      logMessage += `renamed the access key "${command.oldName}" to "${command.newName}"`;
    }

    if (willUpdateTtl) {
      const expirationDate = moment(accessKey.expires).format("LLLL");
      if (willUpdateName) {
        logMessage += ` and changed its expiration date to ${expirationDate}`;
      } else {
        logMessage += `changed the expiration date of the "${command.oldName}" access key to ${expirationDate}`;
      }
    }

    log(`${logMessage}.`);
  });
}

function accessKeyList(command: cli.IAccessKeyListCommand): Promise<void> {
  throwForInvalidOutputFormat(command.format);

  return sdk.getAccessKeys().then((accessKeys: AccessKey[]): void => {
    printAccessKeys(command.format, accessKeys);
  });
}

function accessKeyRemove(command: cli.IAccessKeyRemoveCommand): Promise<void> {
  return confirm().then((wasConfirmed: boolean): Promise<void> => {
    if (wasConfirmed) {
      return sdk.removeAccessKey(command.accessKey).then((): void => {
        log(`Successfully removed the "${command.accessKey}" access key.`);
      });
    }

    log("Access key removal cancelled.");
  });
}

function appAdd(command: cli.IAppAddCommand): Promise<void> {
  return sdk.addApp(command.appName).then((app: App): Promise<void> => {
    log('Successfully added the "' + command.appName + '" app, along with the following default deployments:');
    const deploymentListCommand: cli.IDeploymentListCommand = {
      type: cli.CommandType.deploymentList,
      appName: app.name,
      format: "table",
      displayKeys: true,
    };
    return deploymentList(deploymentListCommand, /*showPackage=*/ false);
  });
}

function appList(command: cli.IAppListCommand): Promise<void> {
  throwForInvalidOutputFormat(command.format);
  let apps: App[];
  return sdk.getApps().then((retrievedApps: App[]): void => {
    printAppList(command.format, retrievedApps);
  });
}

function appRemove(command: cli.IAppRemoveCommand): Promise<void> {
  return confirm("Are you sure you want to remove this app? Note that its deployment keys will be PERMANENTLY unrecoverable.").then(
    (wasConfirmed: boolean): Promise<void> => {
      if (wasConfirmed) {
        return sdk.removeApp(command.appName).then((): void => {
          log('Successfully removed the "' + command.appName + '" app.');
        });
      }

      log("App removal cancelled.");
    }
  );
}

function appRename(command: cli.IAppRenameCommand): Promise<void> {
  return sdk.renameApp(command.currentAppName, command.newAppName).then((): void => {
    log('Successfully renamed the "' + command.currentAppName + '" app to "' + command.newAppName + '".');
  });
}

export const createEmptyTempReleaseFolder = (folderPath: string) => {
  return deleteFolder(folderPath).then(() => {
    fs.mkdirSync(folderPath);
  });
};

function appTransfer(command: cli.IAppTransferCommand): Promise<void> {
  throwForInvalidEmail(command.email);

  return confirm().then((wasConfirmed: boolean): Promise<void> => {
    if (wasConfirmed) {
      return sdk.transferApp(command.appName, command.email).then((): void => {
        log(
          'Successfully transferred the ownership of app "' + command.appName + '" to the account with email "' + command.email + '".'
        );
      });
    }

    log("App transfer cancelled.");
  });
}

function addCollaborator(command: cli.ICollaboratorAddCommand): Promise<void> {
  throwForInvalidEmail(command.email);

  return sdk.addCollaborator(command.appName, command.email).then((): void => {
    log('Successfully added "' + command.email + '" as a collaborator to the app "' + command.appName + '".');
  });
}

function listCollaborators(command: cli.ICollaboratorListCommand): Promise<void> {
  throwForInvalidOutputFormat(command.format);

  return sdk.getCollaborators(command.appName).then((retrievedCollaborators: CollaboratorMap): void => {
    printCollaboratorsList(command.format, retrievedCollaborators);
  });
}

function removeCollaborator(command: cli.ICollaboratorRemoveCommand): Promise<void> {
  throwForInvalidEmail(command.email);

  return confirm().then((wasConfirmed: boolean): Promise<void> => {
    if (wasConfirmed) {
      return sdk.removeCollaborator(command.appName, command.email).then((): void => {
        log('Successfully removed "' + command.email + '" as a collaborator from the app "' + command.appName + '".');
      });
    }

    log("App collaborator removal cancelled.");
  });
}

function deleteConnectionInfoCache(printMessage: boolean = true): void {
  try {
    fs.unlinkSync(configFilePath);

    if (printMessage) {
      log(`Successfully logged-out. The session file located at ${chalk.cyan(configFilePath)} has been deleted.\r\n`);
    }
  } catch (ex) {}
}

function deleteFolder(folderPath: string): Promise<void> {
  return Promise<void>((resolve, reject, notify) => {
    rimraf(folderPath, (err: any) => {
      if (err) {
        reject(err);
      } else {
        resolve(<void>null);
      }
    });
  });
}

function deploymentAdd(command: cli.IDeploymentAddCommand): Promise<void> {
  return sdk.addDeployment(command.appName, command.deploymentName).then((deployment: Deployment): void => {
    log(
      'Successfully added the "' +
        command.deploymentName +
        '" deployment with key "' +
        deployment.key +
        '" to the "' +
        command.appName +
        '" app.'
    );
  });
}

function deploymentHistoryClear(command: cli.IDeploymentHistoryClearCommand): Promise<void> {
  return confirm().then((wasConfirmed: boolean): Promise<void> => {
    if (wasConfirmed) {
      return sdk.clearDeploymentHistory(command.appName, command.deploymentName).then((): void => {
        log(
          'Successfully cleared the release history associated with the "' +
            command.deploymentName +
            '" deployment from the "' +
            command.appName +
            '" app.'
        );
      });
    }

    log("Clear deployment cancelled.");
  });
}

export const deploymentList = (command: cli.IDeploymentListCommand, showPackage: boolean = true): Promise<void> => {
  throwForInvalidOutputFormat(command.format);
  let deployments: Deployment[];

  return sdk
    .getDeployments(command.appName)
    .then((retrievedDeployments: Deployment[]) => {
      deployments = retrievedDeployments;
      if (showPackage) {
        const metricsPromises: Promise<void>[] = deployments.map((deployment: Deployment) => {
          if (deployment.package) {
            return sdk.getDeploymentMetrics(command.appName, deployment.name).then((metrics: DeploymentMetrics): void => {
              if (metrics[deployment.package.label]) {
                const totalActive: number = getTotalActiveFromDeploymentMetrics(metrics);
                (<PackageWithMetrics>deployment.package).metrics = {
                  active: metrics[deployment.package.label].active,
                  downloaded: metrics[deployment.package.label].downloaded,
                  failed: metrics[deployment.package.label].failed,
                  installed: metrics[deployment.package.label].installed,
                  totalActive: totalActive,
                };
              }
            });
          } else {
            return Q(<void>null);
          }
        });

        return Q.all(metricsPromises);
      }
    })
    .then(() => {
      printDeploymentList(command, deployments, showPackage);
    });
};

function deploymentRemove(command: cli.IDeploymentRemoveCommand): Promise<void> {
  return confirm(
    "Are you sure you want to remove this deployment? Note that its deployment key will be PERMANENTLY unrecoverable."
  ).then((wasConfirmed: boolean): Promise<void> => {
    if (wasConfirmed) {
      return sdk.removeDeployment(command.appName, command.deploymentName).then((): void => {
        log('Successfully removed the "' + command.deploymentName + '" deployment from the "' + command.appName + '" app.');
      });
    }

    log("Deployment removal cancelled.");
  });
}

function deploymentRename(command: cli.IDeploymentRenameCommand): Promise<void> {
  return sdk.renameDeployment(command.appName, command.currentDeploymentName, command.newDeploymentName).then((): void => {
    log(
      'Successfully renamed the "' +
        command.currentDeploymentName +
        '" deployment to "' +
        command.newDeploymentName +
        '" for the "' +
        command.appName +
        '" app.'
    );
  });
}

function deploymentHistory(command: cli.IDeploymentHistoryCommand): Promise<void> {
  throwForInvalidOutputFormat(command.format);

  return Q.all<any>([
    sdk.getAccountInfo(),
    sdk.getDeploymentHistory(command.appName, command.deploymentName),
    sdk.getDeploymentMetrics(command.appName, command.deploymentName),
  ]).spread<void>((account: Account, deploymentHistory: Package[], metrics: DeploymentMetrics): void => {
    const totalActive: number = getTotalActiveFromDeploymentMetrics(metrics);
    deploymentHistory.forEach((packageObject: Package) => {
      if (metrics[packageObject.label]) {
        (<PackageWithMetrics>packageObject).metrics = {
          active: metrics[packageObject.label].active,
          downloaded: metrics[packageObject.label].downloaded,
          failed: metrics[packageObject.label].failed,
          installed: metrics[packageObject.label].installed,
          totalActive: totalActive,
        };
      }
    });
    printDeploymentHistory(command, <Package[]>deploymentHistory, account.email);
  });
}

function deserializeConnectionInfo(): ILoginConnectionInfo {
  try {
    const savedConnection: string = fs.readFileSync(configFilePath, {
      encoding: "utf8",
    });
    let connectionInfo: ILegacyLoginConnectionInfo | ILoginConnectionInfo = JSON.parse(savedConnection);

    // If the connection info is in the legacy format, convert it to the modern format
    if ((<ILegacyLoginConnectionInfo>connectionInfo).accessKeyName) {
      connectionInfo = <ILoginConnectionInfo>{
        accessKey: (<ILegacyLoginConnectionInfo>connectionInfo).accessKeyName,
      };
    }

    const connInfo = <ILoginConnectionInfo>connectionInfo;

    return connInfo;
  } catch (ex) {
    return;
  }
}

export function execute(command: cli.ICommand) {
  if (command.type === cli.CommandType.register) {
    console.log("🤔 M_SDK register");
    deleteConnectionInfoCache(false);
    return register(<cli.IRegisterCommand>command);
  }
  // connectionInfo = deserializeConnectionInfo();

  return Q(<void>null).then(() => {
    switch (command.type) {
      // Must not be logged in
      case cli.CommandType.login:
      case cli.CommandType.register:
        // if (connectionInfo) {
        //   throw new Error("You are already logged in from this machine.");
        // }
        break;

      // It does not matter whether you are logged in or not
      case cli.CommandType.link:
        break;

      // Must be logged in
      default:
        if (!!sdk) break; // Used by unit tests to skip authentication

        // if (!connectionInfo) {
        //   throw new Error(
        //     "You are not currently logged in. Run the 'code-push-standalone login' command to authenticate with the CodePush server."
        //   );
        // }

        // sdk = getSdk(connectionInfo.accessKey, CLI_HEADERS, connectionInfo.customServerUrl);
        break;
    }

    switch (command.type) {
      case cli.CommandType.accessKeyAdd:
        return accessKeyAdd(<cli.IAccessKeyAddCommand>command);

      case cli.CommandType.accessKeyPatch:
        return accessKeyPatch(<cli.IAccessKeyPatchCommand>command);

      case cli.CommandType.accessKeyList:
        return accessKeyList(<cli.IAccessKeyListCommand>command);

      case cli.CommandType.accessKeyRemove:
        return accessKeyRemove(<cli.IAccessKeyRemoveCommand>command);

      case cli.CommandType.appAdd:
        return appAdd(<cli.IAppAddCommand>command);

      case cli.CommandType.appList:
        return appList(<cli.IAppListCommand>command);

      case cli.CommandType.appRemove:
        return appRemove(<cli.IAppRemoveCommand>command);

      case cli.CommandType.appRename:
        return appRename(<cli.IAppRenameCommand>command);

      case cli.CommandType.appTransfer:
        return appTransfer(<cli.IAppTransferCommand>command);

      case cli.CommandType.collaboratorAdd:
        return addCollaborator(<cli.ICollaboratorAddCommand>command);

      case cli.CommandType.collaboratorList:
        return listCollaborators(<cli.ICollaboratorListCommand>command);

      case cli.CommandType.collaboratorRemove:
        return removeCollaborator(<cli.ICollaboratorRemoveCommand>command);

      case cli.CommandType.debug:
        return debugCommand(<cli.IDebugCommand>command);

      case cli.CommandType.deploymentAdd:
        return deploymentAdd(<cli.IDeploymentAddCommand>command);

      case cli.CommandType.deploymentHistoryClear:
        return deploymentHistoryClear(<cli.IDeploymentHistoryClearCommand>command);

      case cli.CommandType.deploymentHistory:
        return deploymentHistory(<cli.IDeploymentHistoryCommand>command);

      case cli.CommandType.deploymentList:
        return deploymentList(<cli.IDeploymentListCommand>command);

      case cli.CommandType.deploymentRemove:
        return deploymentRemove(<cli.IDeploymentRemoveCommand>command);

      case cli.CommandType.deploymentRename:
        return deploymentRename(<cli.IDeploymentRenameCommand>command);

      case cli.CommandType.link:
        return link(<cli.ILinkCommand>command);

      case cli.CommandType.login:
        return login(<cli.ILoginCommand>command);

      case cli.CommandType.logout:
        return logout(command);

      case cli.CommandType.patch:
        return patch(<cli.IPatchCommand>command);

      case cli.CommandType.promote:
        return promote(<cli.IPromoteCommand>command);

      case cli.CommandType.register:
        return register(<cli.IRegisterCommand>command);

      case cli.CommandType.release:
        return release(<cli.IReleaseCommand>command);

      case cli.CommandType.releaseReact:
        return releaseReact(<cli.IReleaseReactCommand>command);

      case cli.CommandType.rollback:
        return rollback(<cli.IRollbackCommand>command);

      case cli.CommandType.sessionList:
        return sessionList(<cli.ISessionListCommand>command);

      case cli.CommandType.sessionRemove:
        return sessionRemove(<cli.ISessionRemoveCommand>command);

      case cli.CommandType.whoami:
        return whoami(command);

      default:
        // We should never see this message as invalid commands should be caught by the argument parser.
        throw new Error("Invalid command:  " + JSON.stringify(command));
    }
  });
}

function getTotalActiveFromDeploymentMetrics(metrics: DeploymentMetrics): number {
  let totalActive = 0;
  Object.keys(metrics).forEach((label: string) => {
    totalActive += metrics[label].active;
  });

  return totalActive;
}

function initiateExternalAuthenticationAsync(action: string, serverUrl?: string): void {
  const message: string =
    `A browser is being launched to authenticate your account. Follow the instructions ` +
    `it displays to complete your ${action === "register" ? "registration" : action}.`;

  log(message);
  const hostname: string = os.hostname();
  const url: string = `${serverUrl || AccountManager.SERVER_URL}/auth/${action}?hostname=${hostname}`;
  opener(url);
}

function link(command: cli.ILinkCommand): Promise<void> {
  initiateExternalAuthenticationAsync("link", command.serverUrl);
  return Q(<void>null);
}

function login(command: cli.ILoginCommand): Promise<void> {
  // Check if one of the flags were provided.
  if (command.accessKey) {
    sdk = getSdk(command.accessKey, CLI_HEADERS, command.serverUrl);
    return sdk.isAuthenticated().then((isAuthenticated: boolean): void => {
      if (isAuthenticated) {
        serializeConnectionInfo(command.accessKey, /*preserveAccessKeyOnLogout*/ true, command.serverUrl);
      } else {
        throw new Error("Invalid access key.");
      }
    });
  } else {
    return loginWithExternalAuthentication("login", command.serverUrl);
  }
}

function loginWithExternalAuthentication(action: string, serverUrl?: string): Promise<void> {
  initiateExternalAuthenticationAsync(action, serverUrl);
  log(""); // Insert newline

  return requestAccessKey().then((accessKey: string): Promise<void> => {
    if (accessKey === null) {
      // The user has aborted the synchronous prompt (e.g.:  via [CTRL]+[C]).
      return;
    }

    sdk = getSdk(accessKey, CLI_HEADERS, serverUrl);

    return sdk.isAuthenticated().then((isAuthenticated: boolean): void => {
      if (isAuthenticated) {
        serializeConnectionInfo(accessKey, /*preserveAccessKeyOnLogout*/ false, serverUrl);
      } else {
        throw new Error("Invalid access key.");
      }
    });
  });
}

function logout(command: cli.ICommand): Promise<void> {
  return Q(<void>null)
    .then((): Promise<void> => {
      if (!connectionInfo.preserveAccessKeyOnLogout) {
        const machineName: string = os.hostname();
        return sdk.removeSession(machineName).catch((error: CodePushError) => {
          // If we are not authenticated or the session doesn't exist anymore, just swallow the error instead of displaying it
          if (error.statusCode !== AccountManager.ERROR_UNAUTHORIZED && error.statusCode !== AccountManager.ERROR_NOT_FOUND) {
            throw error;
          }
        });
      }
    })
    .then((): void => {
      sdk = null;
      deleteConnectionInfoCache();
    });
}

function formatDate(unixOffset: number): string {
  const date: moment.Moment = moment(unixOffset);
  const now: moment.Moment = moment();
  if (Math.abs(now.diff(date, "days")) < 30) {
    return date.fromNow(); // "2 hours ago"
  } else if (now.year() === date.year()) {
    return date.format("MMM D"); // "Nov 6"
  } else {
    return date.format("MMM D, YYYY"); // "Nov 6, 2014"
  }
}

function printAppList(format: string, apps: App[]): void {
  if (format === "json") {
    printJson(apps);
  } else if (format === "table") {
    const headers = ["Name", "Deployments"];
    printTable(headers, (dataSource: any[]): void => {
      apps.forEach((app: App, index: number): void => {
        const row = [app.name, wordwrap(50)(app.deployments.join(", "))];
        dataSource.push(row);
      });
    });
  }
}

function getCollaboratorDisplayName(email: string, collaboratorProperties: CollaboratorProperties): string {
  return collaboratorProperties.permission === AccountManager.AppPermission.OWNER ? email + chalk.magenta(" (Owner)") : email;
}

function printCollaboratorsList(format: string, collaborators: CollaboratorMap): void {
  if (format === "json") {
    const dataSource = { collaborators: collaborators };
    printJson(dataSource);
  } else if (format === "table") {
    const headers = ["E-mail Address"];
    printTable(headers, (dataSource: any[]): void => {
      Object.keys(collaborators).forEach((email: string): void => {
        const row = [getCollaboratorDisplayName(email, collaborators[email])];
        dataSource.push(row);
      });
    });
  }
}

function printDeploymentList(command: cli.IDeploymentListCommand, deployments: Deployment[], showPackage: boolean = true): void {
  if (command.format === "json") {
    printJson(deployments);
  } else if (command.format === "table") {
    const headers = ["Name"];
    if (command.displayKeys) {
      headers.push("Deployment Key");
    }

    if (showPackage) {
      headers.push("Update Metadata");
      headers.push("Install Metrics");
    }

    printTable(headers, (dataSource: any[]): void => {
      deployments.forEach((deployment: Deployment): void => {
        const row = [deployment.name];
        if (command.displayKeys) {
          row.push(deployment.key);
        }

        if (showPackage) {
          row.push(getPackageString(deployment.package));
          row.push(getPackageMetricsString(deployment.package));
        }

        dataSource.push(row);
      });
    });
  }
}

function printDeploymentHistory(command: cli.IDeploymentHistoryCommand, deploymentHistory: Package[], currentUserEmail: string): void {
  if (command.format === "json") {
    printJson(deploymentHistory);
  } else if (command.format === "table") {
    const headers = ["Label", "Release Time", "App Version", "Mandatory"];
    if (command.displayAuthor) {
      headers.push("Released By");
    }

    headers.push("Description", "Install Metrics");

    printTable(headers, (dataSource: any[]) => {
      deploymentHistory.forEach((packageObject: Package) => {
        let releaseTime: string = formatDate(packageObject.uploadTime);
        let releaseSource: string;
        if (packageObject.releaseMethod === "Promote") {
          releaseSource = `Promoted ${packageObject.originalLabel} from "${packageObject.originalDeployment}"`;
        } else if (packageObject.releaseMethod === "Rollback") {
          const labelNumber: number = parseInt(packageObject.label.substring(1));
          const lastLabel: string = "v" + (labelNumber - 1);
          releaseSource = `Rolled back ${lastLabel} to ${packageObject.originalLabel}`;
        }

        if (releaseSource) {
          releaseTime += "\n" + chalk.magenta(`(${releaseSource})`).toString();
        }

        let row: string[] = [packageObject.label, releaseTime, packageObject.appVersion, packageObject.isMandatory ? "Yes" : "No"];
        if (command.displayAuthor) {
          let releasedBy: string = packageObject.releasedBy ? packageObject.releasedBy : "";
          if (currentUserEmail && releasedBy === currentUserEmail) {
            releasedBy = "You";
          }

          row.push(releasedBy);
        }

        row.push(packageObject.description ? wordwrap(30)(packageObject.description) : "");
        row.push(getPackageMetricsString(packageObject) + (packageObject.isDisabled ? `\n${chalk.green("Disabled:")} Yes` : ""));
        if (packageObject.isDisabled) {
          row = row.map((cellContents: string) => applyChalkSkippingLineBreaks(cellContents, (<any>chalk).dim));
        }

        dataSource.push(row);
      });
    });
  }
}

function applyChalkSkippingLineBreaks(applyString: string, chalkMethod: (string: string) => any): string {
  // Used to prevent "chalk" from applying styles to linebreaks which
  // causes table border chars to have the style applied as well.
  return applyString
    .split("\n")
    .map((token: string) => chalkMethod(token))
    .join("\n");
}

function getPackageString(packageObject: Package): string {
  if (!packageObject) {
    return chalk.magenta("No updates released").toString();
  }

  let packageString: string =
    chalk.green("Label: ") +
    packageObject.label +
    "\n" +
    chalk.green("App Version: ") +
    packageObject.appVersion +
    "\n" +
    chalk.green("Mandatory: ") +
    (packageObject.isMandatory ? "Yes" : "No") +
    "\n" +
    chalk.green("Release Time: ") +
    formatDate(packageObject.uploadTime) +
    "\n" +
    chalk.green("Released By: ") +
    (packageObject.releasedBy ? packageObject.releasedBy : "") +
    (packageObject.description ? wordwrap(70)("\n" + chalk.green("Description: ") + packageObject.description) : "");

  if (packageObject.isDisabled) {
    packageString += `\n${chalk.green("Disabled:")} Yes`;
  }

  return packageString;
}

function getPackageMetricsString(obj: Package): string {
  const packageObject = <PackageWithMetrics>obj;
  const rolloutString: string =
    obj && obj.rollout && obj.rollout !== 100 ? `\n${chalk.green("Rollout:")} ${obj.rollout.toLocaleString()}%` : "";

  if (!packageObject || !packageObject.metrics) {
    return chalk.magenta("No installs recorded").toString() + (rolloutString || "");
  }

  const activePercent: number = packageObject.metrics.totalActive
    ? (packageObject.metrics.active / packageObject.metrics.totalActive) * 100
    : 0.0;
  let percentString: string;
  if (activePercent === 100.0) {
    percentString = "100%";
  } else if (activePercent === 0.0) {
    percentString = "0%";
  } else {
    percentString = activePercent.toPrecision(2) + "%";
  }

  const numPending: number = packageObject.metrics.downloaded - packageObject.metrics.installed - packageObject.metrics.failed;
  let returnString: string =
    chalk.green("Active: ") +
    percentString +
    " (" +
    packageObject.metrics.active.toLocaleString() +
    " of " +
    packageObject.metrics.totalActive.toLocaleString() +
    ")\n" +
    chalk.green("Total: ") +
    packageObject.metrics.installed.toLocaleString();

  if (numPending > 0) {
    returnString += " (" + numPending.toLocaleString() + " pending)";
  }

  if (packageObject.metrics.failed) {
    returnString += "\n" + chalk.green("Rollbacks: ") + chalk.red(packageObject.metrics.failed.toLocaleString() + "");
  }

  if (rolloutString) {
    returnString += rolloutString;
  }

  return returnString;
}

/**
 * React Native 프로젝트의 앱 버전을 검색합니다.
 * @param command - 명령어 객체
 * @param projectName - 프로젝트 이름
 * @returns Promise<string> - 앱 버전
 */
function getReactNativeProjectAppVersion(command: cli.IReleaseReactCommand, projectName: string): Promise<string> {
  log(chalk.cyan(`Detecting ${command.platform} app version:\n`));

  // ios 환경
  if (command.platform === "ios") {
    let resolvedPlistFile: string = command.plistFile;
    if (resolvedPlistFile) {
      // 명시적으로 제공된 plist 파일 경로가 있는 경우, 해당 경로를 사용합니다.
      if (!fileExists(resolvedPlistFile)) {
        throw new Error("The specified plist file doesn't exist. Please check that the provided path is correct.");
      }
    } else {
      // 명시적으로 제공된 plist 파일 경로가 없는 경우, 일반적인 위치(ios/[프로젝트명]/Info.plist 또는 ios/Info.plist)에서 plist 파일을 검색합니다.
      // plist 파일 이름은 Info.plist 이며, 파일 이름 앞에 접두사를 붙일 수 있습니다.
      // 접두사는 선택적으로 하이픈(-)을 포함할 수 있습니다.
      if (command.plistFilePrefix && /.+[^-.]$/.test(command.plistFilePrefix)) {
        command.plistFilePrefix += "-";
      }

      const iOSDirectory: string = "ios";
      const plistFileName = `${command.plistFilePrefix || ""}Info.plist`;

      const knownLocations = [path.join(iOSDirectory, projectName, plistFileName), path.join(iOSDirectory, plistFileName)];

      resolvedPlistFile = (<any>knownLocations).find(fileExists);

      if (!resolvedPlistFile) {
        throw new Error(
          `Unable to find either of the following plist files in order to infer your app's binary version: "${knownLocations.join(
            '", "'
          )}". If your plist has a different name, or is located in a different directory, consider using either the "--plistFile" or "--plistFilePrefix" parameters to help inform the CLI how to find it.`
        );
      }
    }

    const plistContents = fs.readFileSync(resolvedPlistFile).toString();

    let parsedPlist;

    try {
      parsedPlist = plist.parse(plistContents);
    } catch (e) {
      throw new Error(`Unable to parse "${resolvedPlistFile}". Please ensure it is a well-formed plist file.`);
    }

    // plist 파일의 CFBundleShortVersionString 키에서 버전 값을 추출합니다.
    if (parsedPlist && parsedPlist.CFBundleShortVersionString) {
      // 버전 값이 유효한 Semver 형식인지 확인합니다.
      if (isValidVersion(parsedPlist.CFBundleShortVersionString)) {
        log(`Using the target binary version value "${parsedPlist.CFBundleShortVersionString}" from "${resolvedPlistFile}".\n`);
        return Q(parsedPlist.CFBundleShortVersionString);
      } else {
        // 버전 값이 유효한 Semver 형식이 아닌 경우, 오류를 발생시킵니다.
        if (parsedPlist.CFBundleShortVersionString !== "$(MARKETING_VERSION)") {
          throw new Error(
            `The "CFBundleShortVersionString" key in the "${resolvedPlistFile}" file needs to specify a valid semver string, containing both a major and minor version (e.g. 1.3.2, 1.1).`
          );
        }

        // $(MARKETING_VERSION) 값인 경우 Xcode 프로젝트에서 앱 버전을 검색합니다.
        return getAppVersionFromXcodeProject(command, projectName);
      }
    } else {
      throw new Error(`The "CFBundleShortVersionString" key doesn't exist within the "${resolvedPlistFile}" file.`);
    }
  } 
  // android 환경
  else if (command.platform === "android") {
    // 명시적으로 제공된 gradle 파일 경로가 있는 경우, 해당 경로를 사용합니다.
    // 기본적으로 android/app/build.gradle을 사용합니다.
    let buildGradlePath: string = path.join("android", "app");
    if (command.gradleFile) {
      buildGradlePath = command.gradleFile;
    }
    // gradle 파일이 디렉토리인 경우, build.gradle 파일을 검색합니다.
    if (fs.lstatSync(buildGradlePath).isDirectory()) {
      buildGradlePath = path.join(buildGradlePath, "build.gradle");
    }

    // gradle 파일이 존재하지 않는 경우, 오류를 발생시킵니다.
    if (fileDoesNotExistOrIsDirectory(buildGradlePath)) {
      throw new Error(`Unable to find gradle file "${buildGradlePath}".`);
    }

    // gradle 파일을 파싱합니다.
    return g2js
      .parseFile(buildGradlePath)
      .catch(() => {
        throw new Error(`Unable to parse the "${buildGradlePath}" file. Please ensure it is a well-formed Gradle file.`);
      })
      .then((buildGradle: any) => {
        let versionName: string = null;

        // gradle 파일에 android 노드가 여러 개인 경우, 첫 번째 android 노드를 사용합니다.
        // android.defaultConfig.versionName 키에서 버전 값을 추출합니다.
        if (buildGradle.android instanceof Array) {
          for (let i = 0; i < buildGradle.android.length; i++) {
            const gradlePart = buildGradle.android[i];
            if (gradlePart.defaultConfig && gradlePart.defaultConfig.versionName) {
              versionName = gradlePart.defaultConfig.versionName;
              break;
            }
          }
        } else if (buildGradle.android && buildGradle.android.defaultConfig && buildGradle.android.defaultConfig.versionName) {
          versionName = buildGradle.android.defaultConfig.versionName;
        } else {
          throw new Error(
            `The "${buildGradlePath}" file doesn't specify a value for the "android.defaultConfig.versionName" property.`
          );
        }

        if (typeof versionName !== "string") {
          throw new Error(
            `The "android.defaultConfig.versionName" property value in "${buildGradlePath}" is not a valid string. If this is expected, consider using the --targetBinaryVersion option to specify the value manually.`
          );
        }

        let appVersion: string = versionName.replace(/"/g, "").trim();

        // 버전 값이 유효한 Semver 형식인지 확인합니다.
        if (isValidVersion(appVersion)) {
          // 버전 값이 유효한 Semver 형식인 경우, 해당 값을 사용합니다.
          log(`Using the target binary version value "${appVersion}" from "${buildGradlePath}".\n`);
          return appVersion;
        } else if (/^\d.*/.test(appVersion)) {
          // 버전 값이 유효한 Semver 형식이 아니며, 숫자로 시작하는 경우, 오류를 발생시킵니다.
          throw new Error(
            `The "android.defaultConfig.versionName" property in the "${buildGradlePath}" file needs to specify a valid semver string, containing both a major and minor version (e.g. 1.3.2, 1.1).`
          );
        }

        // 버전 값이 속성 참조인 경우(예: project.version), gradle.properties 파일에서 실제 값을 검색합니다.
        const propertyName = appVersion.replace("project.", "");
        const propertiesFileName = "gradle.properties";

        const knownLocations = [path.join("android", "app", propertiesFileName), path.join("android", propertiesFileName)];

        let propertiesFile: string = null;
        for (let i = 0; i < knownLocations.length; i++) {
          propertiesFile = knownLocations[i];
          if (fileExists(propertiesFile)) {
            const propertiesContent: string = fs.readFileSync(propertiesFile).toString();
            try {
              const parsedProperties: any = properties.parse(propertiesContent);
              appVersion = parsedProperties[propertyName];
              if (appVersion) {
                break;
              }
            } catch (e) {
              throw new Error(`Unable to parse "${propertiesFile}". Please ensure it is a well-formed properties file.`);
            }
          }
        }

        if (!appVersion) {
          throw new Error(`No property named "${propertyName}" exists in the "${propertiesFile}" file.`);
        }

        if (!isValidVersion(appVersion)) {
          throw new Error(
            `The "${propertyName}" property in the "${propertiesFile}" file needs to specify a valid semver string, containing both a major and minor version (e.g. 1.3.2, 1.1).`
          );
        }

        log(`Using the target binary version value "${appVersion}" from the "${propertyName}" key in the "${propertiesFile}" file.\n`);
        return appVersion.toString();
      });
  } else {
    // Window 플랫폼 처리
    const appxManifestFileName: string = "Package.appxmanifest";
    let appxManifestContainingFolder: string;
    let appxManifestContents: string;

    try {
      appxManifestContainingFolder = path.join("windows", projectName);
      appxManifestContents = fs.readFileSync(path.join(appxManifestContainingFolder, "Package.appxmanifest")).toString();
    } catch (err) {
      throw new Error(`Unable to find or read "${appxManifestFileName}" in the "${path.join("windows", projectName)}" folder.`);
    }

    return parseXml(appxManifestContents)
      .catch((err: any) => {
        throw new Error(
          `Unable to parse the "${path.join(appxManifestContainingFolder, appxManifestFileName)}" file, it could be malformed.`
        );
      })
      .then((parsedAppxManifest: any) => {
        try {
          return parsedAppxManifest.Package.Identity[0]["$"].Version.match(/^\d+\.\d+\.\d+/)[0];
        } catch (e) {
          throw new Error(
            `Unable to parse the package version from the "${path.join(appxManifestContainingFolder, appxManifestFileName)}" file.`
          );
        }
      });
  }
}

/**
 * Xcode 프로젝트 파일에서 iOS 앱의 버전 정보를 추출합니다.
 * @param command - 명령어 객체
 * @param projectName - 프로젝트 이름
 * @returns Promise<string> - 앱 버전
 */
function getAppVersionFromXcodeProject(command: cli.IReleaseReactCommand, projectName: string): Promise<string> {
  const pbxprojFileName = "project.pbxproj";
  let resolvedPbxprojFile: string = command.xcodeProjectFile;
  if (resolvedPbxprojFile) {
    // 명시적으로 제공된 pbxproj 파일 경로가 있는 경우, 해당 경로를 사용합니다.
    // 제공된 경로가 pbxproj 파일인지 확인합니다.
    // 경로가 .pbxproj로 끝나지 않으면 해당 경로 내에서 pbxproj 파일 경로를 구성합니다.
    if (!resolvedPbxprojFile.endsWith(pbxprojFileName)) {
      // Specify path to pbxproj file if the provided file path is an Xcode project file.
      resolvedPbxprojFile = path.join(resolvedPbxprojFile, pbxprojFileName);
    }
    if (!fileExists(resolvedPbxprojFile)) {
      throw new Error("The specified pbx project file doesn't exist. Please check that the provided path is correct.");
    }
  } else {
    // 명시적인 경로가 없는 경우 일반적인 위치에서 파일을 검색합니다.
    // 기본적으로 ios/[프로젝트명].xcodeproj/project.pbxproj 또는 ios/project.pbxproj 파일을 검색합니다.
    const iOSDirectory = "ios";
    const xcodeprojDirectory = `${projectName}.xcodeproj`;
    const pbxprojKnownLocations = [
      path.join(iOSDirectory, xcodeprojDirectory, pbxprojFileName),
      path.join(iOSDirectory, pbxprojFileName),
    ];
    resolvedPbxprojFile = pbxprojKnownLocations.find(fileExists);

    if (!resolvedPbxprojFile) {
      throw new Error(
        `Unable to find either of the following pbxproj files in order to infer your app's binary version: "${pbxprojKnownLocations.join(
          '", "'
        )}".`
      );
    }
  }

  // pbxproj 파일을 파싱합니다.
  const xcodeProj = xcode.project(resolvedPbxprojFile).parseSync();
  // getBuildProperty 메서드를 사용하여 MARKETING_VERSION 속성 값을 추출합니다.
  // 지정된 빌드 구성(buildConfigurationName)과 타겟(xcodeTargetName)에 대한 값을 가져옵니다.
  const marketingVersion = xcodeProj.getBuildProperty(
    "MARKETING_VERSION",
    command.buildConfigurationName,
    command.xcodeTargetName
  );
  // 버전 값이 유효한 Semver 형식인지 확인합니다.
  if (!isValidVersion(marketingVersion)) {
    throw new Error(
      `The "MARKETING_VERSION" key in the "${resolvedPbxprojFile}" file needs to specify a valid semver string, containing both a major and minor version (e.g. 1.3.2, 1.1).`
    );
  }
  console.log(`Using the target binary version value "${marketingVersion}" from "${resolvedPbxprojFile}".\n`);

  return marketingVersion;
}

function printJson(object: any): void {
  log(JSON.stringify(object, /*replacer=*/ null, /*spacing=*/ 2));
}

function printAccessKeys(format: string, keys: AccessKey[]): void {
  if (format === "json") {
    printJson(keys);
  } else if (format === "table") {
    printTable(["Name", "Created", "Expires"], (dataSource: any[]): void => {
      const now = new Date().getTime();

      function isExpired(key: AccessKey): boolean {
        return now >= key.expires;
      }

      function keyToTableRow(key: AccessKey, dim: boolean): string[] {
        const row: string[] = [key.name, key.createdTime ? formatDate(key.createdTime) : "", formatDate(key.expires)];

        if (dim) {
          row.forEach((col: string, index: number) => {
            row[index] = (<any>chalk).dim(col);
          });
        }

        return row;
      }

      keys.forEach((key: AccessKey) => !isExpired(key) && dataSource.push(keyToTableRow(key, /*dim*/ false)));
      keys.forEach((key: AccessKey) => isExpired(key) && dataSource.push(keyToTableRow(key, /*dim*/ true)));
    });
  }
}

function printSessions(format: string, sessions: Session[]): void {
  if (format === "json") {
    printJson(sessions);
  } else if (format === "table") {
    printTable(["Machine", "Logged in"], (dataSource: any[]): void => {
      sessions.forEach((session: Session) => dataSource.push([session.machineName, formatDate(session.loggedInTime)]));
    });
  }
}

function printTable(columnNames: string[], readData: (dataSource: any[]) => void): void {
  const table = new Table({
    head: columnNames,
    style: { head: ["cyan"] },
  });

  readData(table);

  log(table.toString());
}

function register(command: cli.IRegisterCommand): Q.Promise<void> {
  return Q.Promise<void>(async (resolve, reject) => {
    const serverUrl = command.serverUrl || AccountManager.SERVER_URL;
    
    // 이메일과 이름을 입력받는 프로미스들 생성
    const emailPromise = prompt("Email: ");
    const namePromise = prompt("Name (optional): ");

    // 모든 프롬프트가 완료되면 진행
    Q.all([emailPromise, namePromise])
      .then(([email, name]) => {
        // SDK 인스턴스 생성
        const sdk = getSdk("", {}, serverUrl);
        
        // register 메서드 호출
        return sdk.register(email, name);
      })
      .then((response) => {
        if (response.body) {
          const { token, accessKey } = response.body;
          
          // 연결 정보 저장
          serializeConnectionInfo(accessKey, /*preserveAccessKeyOnLogout*/ false, serverUrl);
          
          log(`Successfully registered.\nAccess key: ${accessKey}`);
          resolve();
        } else {
          reject(new Error("Invalid server response"));
        }
      })
      .catch((error) => {
        if (error.statusCode === AccountManager.ERROR_CONFLICT) {
          reject(new Error("이미 등록된 이메일입니다."));
        } else {
          reject(error);
        }
      });
  });
}

function promote(command: cli.IPromoteCommand): Promise<void> {
  const packageInfo: PackageInfo = {
    appVersion: command.appStoreVersion,
    description: command.description,
    label: command.label,
    isDisabled: command.disabled,
    isMandatory: command.mandatory,
    rollout: command.rollout,
  };

  return sdk
    .promote(command.appName, command.sourceDeploymentName, command.destDeploymentName, packageInfo)
    .then((): void => {
      log(
        "Successfully promoted " +
          (command.label !== null ? '"' + command.label + '" of ' : "") +
          'the "' +
          command.sourceDeploymentName +
          '" deployment of the "' +
          command.appName +
          '" app to the "' +
          command.destDeploymentName +
          '" deployment.'
      );
    })
    .catch((err: CodePushError) => releaseErrorHandler(err, command));
}

function patch(command: cli.IPatchCommand): Promise<void> {
  const packageInfo: PackageInfo = {
    appVersion: command.appStoreVersion,
    description: command.description,
    isMandatory: command.mandatory,
    isDisabled: command.disabled,
    rollout: command.rollout,
  };

  for (const updateProperty in packageInfo) {
    if ((<any>packageInfo)[updateProperty] !== null) {
      return sdk.patchRelease(command.appName, command.deploymentName, command.label, packageInfo).then((): void => {
        log(
          `Successfully updated the "${command.label ? command.label : `latest`}" release of "${command.appName}" app's "${
            command.deploymentName
          }" deployment.`
        );
      });
    }
  }

  throw new Error("At least one property must be specified to patch a release.");
}

/**
 * 번들링된 파일을 CodePush 서버에 배포합니다.
 * @param command 
 * ```
 * {
 *  appName: string;
 *  appStoreVersion: string;
 *  deploymentName: string;
 *  noDuplicateReleaseError?: boolean;
 *  privateKeyPath?: string;
 *  package: string;
 * }
 * ```
 * @returns Promise<void>
 */
export const release = (command: cli.IReleaseCommand): Promise<void> => {
  // 패키지 파일이 .zip 또는 이진 파일인 경우 오류를 발생시킵니다.
  // 이러한 파일은 이미 번들링된 파일이므로 추가적인 패키징이 필요하지 않습니다.
  console.log('🥹 CLI Release [1]', command.package);
  if (isBinaryOrZip(command.package)) {
    throw new Error(
      "It is unnecessary to package releases in a .zip or binary file. Please specify the direct path to the update content's directory (e.g. /platforms/ios/www) or file (e.g. main.jsbundle)."
    );
  }

  // 앱 버전이 유효한 Semver 형식인지 확인합니다.
  console.log('🥹 CLI Release [2]', command.appStoreVersion);
  throwForInvalidSemverRange(command.appStoreVersion);

  // 패키지 유형을 확인합니다.
  // 패키지가 단일 파일인지 디렉토리인지 확인합니다.
  const filePath: string = command.package;
  let isSingleFilePackage: boolean = true;
  console.log('🥹 CLI Release [3]', filePath);
  if (fs.lstatSync(filePath).isDirectory()) {
    isSingleFilePackage = false;
  }

  // 업로드 진행 상황을 표시하기 위한 진행 표시줄을 설정합니다.
  let lastTotalProgress = 0;
  const progressBar = new progress("Upload progress:[:bar] :percent :etas", {
    complete: "=",
    incomplete: " ",
    width: 50,
    total: 100,
  });
  console.log('🥹 CLI Release [4]', progressBar);
  // 업데이트에 대한 메타데이터를 설정합니다.
  const uploadProgress = (currentProgress: number): void => {
    progressBar.tick(currentProgress - lastTotalProgress);
    lastTotalProgress = currentProgress;
  };
  console.log('🥹 CLI Release [5]', uploadProgress);
  const updateMetadata: PackageInfo = {
    description: command.description, // 업데이트에 대한 설명
    isDisabled: command.disabled, // 업데이트 비활성화 여부
    isMandatory: command.mandatory, // 업데이트 강제 설치 여부
    rollout: command.rollout, // 점진적 배포 비율
  };
  console.log('🥹 CLI Release [6]', updateMetadata);
  // 인증 상태를 확인하고 인증된 경우 업데이트를 배포합니다.
  return sdk
    .isAuthenticated(true)
    .then((isAuth: boolean): Promise<void> => {
      console.log('🥹 CLI Release [7]', isAuth);
      return sdk.release(command.appName, command.deploymentName, filePath, command.appStoreVersion, updateMetadata, uploadProgress);
    })
    .then((): void => {
      log(
        'Successfully released an update containing the "' +
          command.package +
          '" ' +
          (isSingleFilePackage ? "file" : "directory") +
          ' to the "' +
          command.deploymentName +
          '" deployment of the "' +
          command.appName +
          '" app.'
      );
    })
    .catch((err: CodePushError) => releaseErrorHandler(err, command));
};


/**
 * React Native 앱의 업데이트를 CodePush 서버에 배포합니다.
 * @param command 
 * ```
 * {
 *  bundleName?: string;
 *  development?: boolean;
 *  entryFile?: string;
 *  gradleFile?: string;
 *  platform: string;
 *  plistFile?: string;
 *  plistFilePrefix?: string;
 *  sourcemapOutput?: string;
 *  outputDir?: string;
 *  config?: string;
 *  useHermes?: boolean;
 *  extraHermesFlags?: string[];
 *  podFile?: string;
 *  xcodeProjectFile?: string;
 *  xcodeTargetName?: string;
 *  buildConfigurationName?: string;
 * }
 * ```
 * @returns 
 */
export const releaseReact = (command: cli.IReleaseReactCommand): Promise<void> => {
  let bundleName: string = command.bundleName;
  let entryFile: string = command.entryFile;
  const outputFolder: string = command.outputDir || path.join(os.tmpdir(), "CodePush");
  const platform: string = (command.platform = command.platform.toLowerCase());
  const releaseCommand: cli.IReleaseCommand = <any>command;
  // 업데이트 배포 전 앱과 배포 환경의 존재 여부를 확인합니다.
  // 잘못된 앱 이름이나 배포 환경 이름을 입력하지는 않았는지 초기에 검증합니다.
  return (
    sdk
      .getDeployment(command.appName, command.deploymentName)
      .then((): any => {
        console.log("🤔 CLI ReleaseReact: ", command.appName, command.deploymentName);
        releaseCommand.package = outputFolder;
        // 플랫폼 타입에 따라 번들 이름을 설정합니다.
        // iOS: main.jsbundle
        // Android: index.android.bundle
        // Windows: index.windows.bundle
        switch (platform) {
          case "android":
          case "ios":
          case "windows":
            if (!bundleName) {
              bundleName = platform === "ios" ? "main.jsbundle" : `index.${platform}.bundle`;
            }

            break;
          default:
            throw new Error('Platform must be either "android", "ios" or "windows".');
        }
        console.log("🤔 CLI ReleaseReact[2]: ", bundleName);
        let projectName: string;
        
        // 프로젝트 유효성을 검증합니다.  
        // package.json 파일에 앱 이름과 react-native 모듈이 존재하는지 확인합니다.
        try {
          console.log("🤔 CLI ReleaseReact[3]: ", path.join(process.cwd(), "package.json"));
          const projectPackageJson: any = require(path.join(process.cwd(), "package.json"));
          projectName = projectPackageJson.name;
          if (!projectName) {
            throw new Error('The "package.json" file in the CWD does not have the "name" field set.');
          }

          if (!projectPackageJson.dependencies["react-native"]) {
            throw new Error("The project in the CWD is not a React Native project.");
          }
        } catch (error) {
          throw new Error(
            'Unable to find or read "package.json" in the CWD. The "release-react" command must be executed in a React Native project folder.'
          );
        }

        // 진입점 파일이 지정되지 않았다면, 플랫폼 타입에 따라 엔트리 파일을 설정합니다.
        if (!entryFile) {
          console.log("🤔 CLI ReleaseReact[4]: ", `index.${platform}.js`);
          entryFile = `index.${platform}.js`;
          if (fileDoesNotExistOrIsDirectory(entryFile)) {
            console.log("🤔 CLI ReleaseReact[5]: ", "index.js");
            entryFile = "index.js";
          }

          if (fileDoesNotExistOrIsDirectory(entryFile)) {
            console.log("🤔 CLI ReleaseReact[6]: ", `Entry file "index.${platform}.js" or "index.js" does not exist.`);
            throw new Error(`Entry file "index.${platform}.js" or "index.js" does not exist.`);
          }
        } else {
          if (fileDoesNotExistOrIsDirectory(entryFile)) {
            console.log("🤔 CLI ReleaseReact[7]: ", `Entry file "${entryFile}" does not exist.`);
            throw new Error(`Entry file "${entryFile}" does not exist.`);
          }
        }

        // 앱 버전을 결정합니다.
        // 사용자가 --targetBinaryVersion 옵션을 사용하여 명시적으로 버전을 지정했다면, 해당 버전을 사용합니다.
        // 지정된 버전이 없다면, 프로젝트 내에서 사용되는 버전을 찾습니다. 
        // (Android: build.gradle의 versionCode, iOS: Info.plist 또는 XCode 프로젝트의 CFBundleShortVersionString 필드)
        console.log("🤔 CLI ReleaseReact[8]: ", command.appStoreVersion);
        const appVersionPromise: Promise<string> = command.appStoreVersion
          ? Q(command.appStoreVersion)
          : getReactNativeProjectAppVersion(command, projectName);

        if (command.sourcemapOutput && !command.sourcemapOutput.endsWith(".map")) {
          command.sourcemapOutput = path.join(command.sourcemapOutput, bundleName + ".map");
        }

        return appVersionPromise;
      })
      // 임시 폴더를 생성하고 번들러 캐시를 정리합니다.
      // 앱 버전이 유효한 Semver 형식인지 확인 후 임시 출력 폴더를 생성합니다.
      .then((appVersion: string) => {
        console.log("🤔 CLI ReleaseReact[9]: ", appVersion);
        throwForInvalidSemverRange(appVersion);
        releaseCommand.appStoreVersion = appVersion;
        
        return createEmptyTempReleaseFolder(outputFolder);
      })
      // React Native 번들러 캐시를 정리하여 성능 및 오류를 방지합니다.

      .then(() => deleteFolder(`${os.tmpdir()}/react-*`))
      // React Native 번들링을 실행합니다.
      // Metro 번들러를 사용하여 JavaScript 코드를 번들링합니다.
      // 이때 개발 모드 여부, 소스맵 생성 여부 등의 옵션을 적용합니다.
      .then(() => {
        console.log("🤔 CLI ReleaseReact[10]: ", bundleName);
        return runReactNativeBundleCommand(
          bundleName,
          command.development || false,
          entryFile,
          outputFolder,
          platform,
          command.sourcemapOutput
        )
      })
      // Hermes 컴파일러를 실행합니다.
      // Hermes는 JavaScript 코드를 바이트 코드로 컴파일하는 역할을 합니다.
      // Hermes 활성화 여부를 확인하고, 필요한 경우 JavaScript 번들을 Hermes 바이트코드로 변환합니다.
      // 활성화 확인: --useHermes 옵션, build.gradle, Podfile
      .then(async () => {
        console.log("🤔 CLI ReleaseReact[11]: ", command.useHermes);
        const isHermesEnabled =
        command.useHermes ||
        (platform === "android" && (await getAndroidHermesEnabled(command.gradleFile))) || // build.gradle에서 Hermes 활성화 여부 확인
        (platform === "ios" && (await getiOSHermesEnabled(command.podFile))); // Podfile에서 Hermes 활성화 여부 확인

        if (isHermesEnabled) {
          log(chalk.cyan("\nRunning hermes compiler...\n"));
          await runHermesEmitBinaryCommand(
            bundleName,
            outputFolder,
            command.sourcemapOutput,
            command.extraHermesFlags,
            command.gradleFile
          );
        }
      })
      // --privateKeyPath 옵션이 제공된 경우 번들 서명을 실행합니다.
      // 번들 서명은 번들의 무결성을 보장하고, 번들의 소유권을 증명하는 데 사용됩니다.
      // 서명 키 경로가 지정되지 않았다면, 서명 키를 생성하고 저장합니다.
      .then(async () => {
        console.log("🤔 CLI ReleaseReact[12]: ", command.privateKeyPath);
        if (command.privateKeyPath) {
          log(chalk.cyan("\nSigning the bundle:\n"));
          await sign(command.privateKeyPath, outputFolder);
        } else {
          console.log("private key was not provided");
        }
      })
      // 번들 업데이트를 CodePush 서버에 배포합니다.
      // AccountManager 클래스의 release 메서드를 호출하여 번들링된 파일과 메타데이터를 업로드합니다.
      .then(() => {
        console.log("🤔 CLI ReleaseReact[13]: ", releaseCommand);
        log(chalk.cyan("\nReleasing update contents to CodePush:\n"));
        return release(releaseCommand);
      })
      // 사용자가 출력 디렉토리를 지정하지 않은 경우 해당 폴더를 삭제합니다.
      // 오류가 발생한 경우에도 임시 폴더를 정리합니다.
      .then(() => {
        console.log("🤔 CLI ReleaseReact[14]: ", command.outputDir);
        if (!command.outputDir) {
          deleteFolder(outputFolder);
        }
      })
      .catch((err: Error) => {
        deleteFolder(outputFolder);
        throw err;
      })
  );
};

function rollback(command: cli.IRollbackCommand): Promise<void> {
  return confirm().then((wasConfirmed: boolean) => {
    if (!wasConfirmed) {
      log("Rollback cancelled.");
      return;
    }

    return sdk.rollback(command.appName, command.deploymentName, command.targetRelease || undefined).then((): void => {
      log(
        'Successfully performed a rollback on the "' + command.deploymentName + '" deployment of the "' + command.appName + '" app.'
      );
    });
  });
}

function requestAccessKey(): Promise<string> {
  return Promise<string>((resolve, reject, notify): void => {
    prompt.message = "";
    prompt.delimiter = "";

    prompt.start();

    prompt.get(
      {
        properties: {
          response: {
            description: chalk.cyan("Enter your access key: "),
          },
        },
      },
      (err: any, result: any): void => {
        if (err) {
          resolve(null);
        } else {
          resolve(result.response.trim());
        }
      }
    );
  });
}

/**
 * React Native 번들링을 실행합니다.
 * @param bundleName 생성될 번들 파일의 이름
 * @param development 개발 모드 여부
 * @param entryFile 번들링의 시작점이 되는 JavaScript 파일 경로
 * @param outputFolder 번들 파일을 저장할 디렉토리
 * @param platform 대상 플랫폼(ios, android, windows)
 * @param sourcemapOutput 소스맵 파일 출력 경로 (디버깅용)
 * @returns 
 */
export const runReactNativeBundleCommand = (
  bundleName: string,
  development: boolean,
  entryFile: string,
  outputFolder: string,
  platform: string,
  sourcemapOutput: string
): Promise<void> => {
  console.log("🤔 CLI RunReactNativeBundleCommand: ", bundleName);
  const reactNativeBundleArgs: string[] = [];
  // 환경 변수에서 CODE_PUSH_NODE_ARGS를 추출합니다.
  const envNodeArgs: string = process.env.CODE_PUSH_NODE_ARGS;

  if (typeof envNodeArgs !== "undefined") {
    Array.prototype.push.apply(reactNativeBundleArgs, envNodeArgs.trim().split(/\s+/));
  }
  
  const isOldCLI = fs.existsSync(path.join("node_modules", "react-native", "local-cli", "cli.js"));
  
  // React Native CLI 경로를 설정합니다.
  // 구버전 CLI: node_modules/react-native/local-cli/cli.js
  // 신버전 CLI: node_modules/react-native/cli.js
  // 번들링에 필요한 인자들을 구성합니다.
  Array.prototype.push.apply(reactNativeBundleArgs, [
    isOldCLI ? path.join("node_modules", "react-native", "local-cli", "cli.js") : path.join("node_modules", "react-native", "cli.js"),
    "bundle",
    "--assets-dest", // 에셋 파일 저장 경로
    outputFolder,
    "--bundle-output", // 번들 파일 저장 경로
    path.join(outputFolder, bundleName),
    "--dev", // 개발 모드 여부
    development,
    "--entry-file", // 진입점 파일 경로
    entryFile,
    "--platform",
    platform,
  ]);
  console.log("🤔 CLI RunReactNativeBundleCommand[2]: ", reactNativeBundleArgs);
  // 소스맵 파일 출력 경로가 지정된 경우, 소스맵 파일 출력 경로를 추가합니다.
  if (sourcemapOutput) {
    reactNativeBundleArgs.push("--sourcemap-output", sourcemapOutput);
  }
  console.log("🤔 CLI RunReactNativeBundleCommand[3]: ", reactNativeBundleArgs);
  // 번들링 명령을 실행합니다.
  log(chalk.cyan('Running "react-native bundle" command:\n'));
  const reactNativeBundleProcess = spawn("node", reactNativeBundleArgs);
  log(`node ${reactNativeBundleArgs.join(" ")}`);

  // 번들링 명령 실행 결과를 처리합니다.
  return Promise<void>((resolve, reject, notify) => {
    console.log("🤔 CLI RunReactNativeBundleCommand[4]: ", reactNativeBundleProcess);
    reactNativeBundleProcess.stdout.on("data", (data: Buffer) => {
      console.log("🤔 CLI RunReactNativeBundleCommand[5]: ", data.toString().trim());
      log(data.toString().trim());
    });

    reactNativeBundleProcess.stderr.on("data", (data: Buffer) => {
      console.error(data.toString().trim());
    });

    reactNativeBundleProcess.on("close", (exitCode: number) => {
      console.log("🤔 CLI RunReactNativeBundleCommand[5]: ", exitCode);
      if (exitCode) {
        console.log("🤔 CLI RunReactNativeBundleCommand[6]: ", `"react-native bundle" command exited with code ${exitCode}.`);
        reject(new Error(`"react-native bundle" command exited with code ${exitCode}.`));
      }

      resolve(<void>null);
    });
  });
};

function serializeConnectionInfo(accessKey: string, preserveAccessKeyOnLogout: boolean, customServerUrl?: string): void {
  const connectionInfo: ILoginConnectionInfo = {
    accessKey: accessKey,
    preserveAccessKeyOnLogout: preserveAccessKeyOnLogout,
  };
  if (customServerUrl) {
    connectionInfo.customServerUrl = customServerUrl;
  }

  const json: string = JSON.stringify(connectionInfo);
  fs.writeFileSync(configFilePath, json, { encoding: "utf8" });

  log(
    `\r\nSuccessfully logged-in. Your session file was written to ${chalk.cyan(configFilePath)}. You can run the ${chalk.cyan(
      "code-push logout"
    )} command at any time to delete this file and terminate your session.\r\n`
  );
}

function sessionList(command: cli.ISessionListCommand): Promise<void> {
  throwForInvalidOutputFormat(command.format);

  return sdk.getSessions().then((sessions: Session[]): void => {
    printSessions(command.format, sessions);
  });
}

function sessionRemove(command: cli.ISessionRemoveCommand): Promise<void> {
  if (os.hostname() === command.machineName) {
    throw new Error("Cannot remove the current login session via this command. Please run 'code-push-standalone logout' instead.");
  } else {
    return confirm().then((wasConfirmed: boolean): Promise<void> => {
      if (wasConfirmed) {
        return sdk.removeSession(command.machineName).then((): void => {
          log(`Successfully removed the login session for "${command.machineName}".`);
        });
      }

      log("Session removal cancelled.");
    });
  }
}

function releaseErrorHandler(error: CodePushError, command: cli.ICommand): void {
  if ((<any>command).noDuplicateReleaseError && error.statusCode === AccountManager.ERROR_CONFLICT) {
    console.warn(chalk.yellow("[Warning] " + error.message));
  } else {
    throw error;
  }
}

function throwForInvalidEmail(email: string): void {
  if (!emailValidator.validate(email)) {
    throw new Error('"' + email + '" is an invalid e-mail address.');
  }
}

/**
 * 유효하지 않은 Semver 범위를 확인하고 오류를 발생시킵니다.
 * > **Semver(Sementic Versioning)**
 * -  소프트웨어 버전을 관리하기 위한 표준화된 버전 번호 지정 시스템
 * - `MAJOR.MINOR.PATCH` 형식으로 구성되어 있습니다.
 * @param semverRange 
 */
function throwForInvalidSemverRange(semverRange: string): void {
  if (semver.validRange(semverRange) === null) {
    throw new Error('Please use a semver-compliant target binary version range, for example "1.0.0", "*" or "^1.2.3".');
  }
}

function throwForInvalidOutputFormat(format: string): void {
  switch (format) {
    case "json":
    case "table":
      break;

    default:
      throw new Error("Invalid format:  " + format + ".");
  }
}

function whoami(command: cli.ICommand): Promise<void> {
  return sdk.getAccountInfo().then((account): void => {
    const accountInfo = `${account.email} (${account.linkedProviders.join(", ")})`;

    log(accountInfo);
  });
}

function isCommandOptionSpecified(option: any): boolean {
  return option !== undefined && option !== null;
}

function getSdk(accessKey: string, headers: Headers, customServerUrl: string): AccountManager {
  const sdk: any = new AccountManager(accessKey, CLI_HEADERS, customServerUrl);
  /*
   * If the server returns `Unauthorized`, it must be due to an invalid
   * (or expired) access key. For convenience, we patch every SDK call
   * to delete the cached connection so the user can simply
   * login again instead of having to log out first.
   */
  Object.getOwnPropertyNames(AccountManager.prototype).forEach((functionName: any) => {
    if (typeof sdk[functionName] === "function") {
      const originalFunction = sdk[functionName];
      sdk[functionName] = function () {
        let maybePromise: Promise<any> = originalFunction.apply(sdk, arguments);
        if (maybePromise && maybePromise.then !== undefined) {
          maybePromise = maybePromise.catch((error: any) => {
            if (error.statusCode && error.statusCode === AccountManager.ERROR_UNAUTHORIZED) {
              deleteConnectionInfoCache(/* printMessage */ false);
            }

            throw error;
          });
        }

        return maybePromise;
      };
    }
  });

  return sdk;
}

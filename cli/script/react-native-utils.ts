import * as chalk from "chalk";
import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";
import { coerce, compare, valid } from "semver";
import { fileDoesNotExistOrIsDirectory } from "./utils/file-utils";

const g2js = require("gradle-to-js/lib/parser");

/**
 * 주어진 버전 문자열이 유효한 Semver 버전인지 확인합니다.
 * @param version - 확인할 버전 문자열
 * @returns 유효한 버전인 경우 true, 그렇지 않으면 false
 */
export function isValidVersion(version: string): boolean {
  return !!valid(version) || /^\d+\.\d+$/.test(version);
}

/**
 * JavaScript 번들을 Hermes 바이트코드로 변환하는 명령을 실행합니다.
 * 변환된 바이트코드 파일을 원래 JS 번들 위치로 복사합니다.
 * 소스맵이 활성화된 경우 소스맵을 합성합니다.
 * @param bundleName - 번들 이름
 * @param outputFolder - 출력 폴더
 * @param sourcemapOutput - 소스맵 출력 경로
 * @param extraHermesFlags - 추가 플래그
 * @param gradleFile - Gradle 파일 경로
 * @returns Promise<void>
 */
export async function runHermesEmitBinaryCommand(
    bundleName: string,
    outputFolder: string,
    sourcemapOutput: string,
    extraHermesFlags: string[],
    gradleFile: string
): Promise<void> {
  const hermesArgs: string[] = [];
  const envNodeArgs: string = process.env.CODE_PUSH_NODE_ARGS;

  if (typeof envNodeArgs !== "undefined") {
    Array.prototype.push.apply(hermesArgs, envNodeArgs.trim().split(/\s+/));
  }

  Array.prototype.push.apply(hermesArgs, [
    "-emit-binary",
    "-out",
    path.join(outputFolder, bundleName + ".hbc"),
    path.join(outputFolder, bundleName),
    ...extraHermesFlags,
  ]);

  if (sourcemapOutput) {
    hermesArgs.push("-output-source-map");
  }

  console.log(chalk.cyan("Converting JS bundle to byte code via Hermes, running command:\n"));
  const hermesCommand = await getHermesCommand(gradleFile);
  const hermesProcess = childProcess.spawn(hermesCommand, hermesArgs);
  console.log(`${hermesCommand} ${hermesArgs.join(" ")}`);

  return new Promise<void>((resolve, reject) => {
    hermesProcess.stdout.on("data", (data: Buffer) => {
      console.log(data.toString().trim());
    });

    hermesProcess.stderr.on("data", (data: Buffer) => {
      console.error(data.toString().trim());
    });

    hermesProcess.on("close", (exitCode: number, signal: string) => {
      if (exitCode !== 0) {
        reject(new Error(`"hermes" command failed (exitCode=${exitCode}, signal=${signal}).`));
      }
      // Copy HBC bundle to overwrite JS bundle
      const source = path.join(outputFolder, bundleName + ".hbc");
      const destination = path.join(outputFolder, bundleName);
      fs.copyFile(source, destination, (err) => {
        if (err) {
          console.error(err);
          reject(new Error(`Copying file ${source} to ${destination} failed. "hermes" previously exited with code ${exitCode}.`));
        }
        fs.unlink(source, (err) => {
          if (err) {
            console.error(err);
            reject(err);
          }
          resolve(null as void);
        });
      });
    });
  }).then(() => {
    if (!sourcemapOutput) {
      // skip source map compose if source map is not enabled
      return;
    }

    const composeSourceMapsPath = getComposeSourceMapsPath();
    if (!composeSourceMapsPath) {
      throw new Error("react-native compose-source-maps.js scripts is not found");
    }

    const jsCompilerSourceMapFile = path.join(outputFolder, bundleName + ".hbc" + ".map");
    if (!fs.existsSync(jsCompilerSourceMapFile)) {
      throw new Error(`sourcemap file ${jsCompilerSourceMapFile} is not found`);
    }

    return new Promise((resolve, reject) => {
      const composeSourceMapsArgs = [composeSourceMapsPath, sourcemapOutput, jsCompilerSourceMapFile, "-o", sourcemapOutput];

      // https://github.com/facebook/react-native/blob/master/react.gradle#L211
      // https://github.com/facebook/react-native/blob/master/scripts/react-native-xcode.sh#L178
      // packager.sourcemap.map + hbc.sourcemap.map = sourcemap.map
      const composeSourceMapsProcess = childProcess.spawn("node", composeSourceMapsArgs);
      console.log(`${composeSourceMapsPath} ${composeSourceMapsArgs.join(" ")}`);

      composeSourceMapsProcess.stdout.on("data", (data: Buffer) => {
        console.log(data.toString().trim());
      });

      composeSourceMapsProcess.stderr.on("data", (data: Buffer) => {
        console.error(data.toString().trim());
      });

      composeSourceMapsProcess.on("close", (exitCode: number, signal: string) => {
        if (exitCode !== 0) {
          reject(new Error(`"compose-source-maps" command failed (exitCode=${exitCode}, signal=${signal}).`));
        }

        // Delete the HBC sourceMap, otherwise it will be included in 'code-push' bundle as well
        fs.unlink(jsCompilerSourceMapFile, (err) => {
          if (err) {
            console.error(err);
            reject(err);
          }

          resolve(null);
        });
      });
    });
  });
}

/**
 * Android 프로젝트의 build.gradle 파일을 파싱하여 프로젝트 설정을 추출합니다.
 * @param gradleFile - Gradle 파일 경로
 * @returns Promise<any> - Gradle 파일 내용
 */
function parseBuildGradleFile(gradleFile: string) {
  let buildGradlePath: string = path.join("android", "app");
  if (gradleFile) {
    buildGradlePath = gradleFile;
  }
  if (fs.lstatSync(buildGradlePath).isDirectory()) {
    buildGradlePath = path.join(buildGradlePath, "build.gradle");
  }

  if (fileDoesNotExistOrIsDirectory(buildGradlePath)) {
    throw new Error(`Unable to find gradle file "${buildGradlePath}".`);
  }

  return g2js.parseFile(buildGradlePath).catch(() => {
    throw new Error(`Unable to parse the "${buildGradlePath}" file. Please ensure it is a well-formed Gradle file.`);
  });
}

/**
 * Gradle 파일에서 Hermes 명령을 추출합니다.
 * @param gradleFile - Gradle 파일 경로
 * @returns Promise<string> - Hermes 명령 (`hermesCommand`)
 */
async function getHermesCommandFromGradle(gradleFile: string): Promise<string> {
  const buildGradle: any = await parseBuildGradleFile(gradleFile);
  const hermesCommandProperty: any = Array.from(buildGradle["project.ext.react"] || []).find((prop: string) =>
    prop.trim().startsWith("hermesCommand:")
  );
  if (hermesCommandProperty) {
    return hermesCommandProperty.replace("hermesCommand:", "").trim().slice(1, -1);
  } else {
    return "";
  }
}

/**
 * Gradle 파일에서 Hermes 활성화 여부를 확인합니다.
 * @param gradleFile - Gradle 파일 경로
 * @returns Promise<boolean> - Hermes 활성화 여부
 */
export function getAndroidHermesEnabled(gradleFile: string): boolean {
  return parseBuildGradleFile(gradleFile).then((buildGradle: any) => {
    return Array.from(buildGradle["project.ext.react"] || []).some((line: string) => /^enableHermes\s{0,}:\s{0,}true/.test(line));
  });
}

/**
 * iOS 프로젝트의 Podfile 파일에서 Hermes 활성화 여부를 확인합니다.
 * @param podFile - Podfile 파일 경로
 * @returns boolean - Hermes 활성화 여부
 */
export function getiOSHermesEnabled(podFile: string): boolean {
  let podPath = path.join("ios", "Podfile");
  if (podFile) {
    podPath = podFile;
  }
  if (fileDoesNotExistOrIsDirectory(podPath)) {
    throw new Error(`Unable to find Podfile file "${podPath}".`);
  }

  try {
    const podFileContents = fs.readFileSync(podPath).toString();
    return /([^#\n]*:?hermes_enabled(\s+|\n+)?(=>|:)(\s+|\n+)?true)/.test(podFileContents);
  } catch (error) {
    throw error;
  }
}

/**
 * 현재 운영체제에 맞는 Hermes 실행 파일 이름을 반환합니다.
 * @returns string - Hermes 바이너리 폴더 이름
 */
function getHermesOSBin(): string {
  switch (process.platform) {
    case "win32":
      return "win64-bin";
    case "darwin":
      return "osx-bin";
    case "freebsd":
    case "linux":
    case "sunos":
    default:
      return "linux64-bin";
  }
}

/**
 * 현재 운영체제에 맞는 Hermes 실행 파일 이름을 반환합니다.
 * React Native 버전에 따라 `hermesc` 또는 `hermes` 실행 파일을 반환합니다.
 * @returns string - Hermes 실행 파일 이름
 */
function getHermesOSExe(): string {
  const react63orAbove = compare(coerce(getReactNativeVersion()).version, "0.63.0") !== -1;
  const hermesExecutableName = react63orAbove ? "hermesc" : "hermes";
  switch (process.platform) {
    case "win32":
      return hermesExecutableName + ".exe";
    default:
      return hermesExecutableName;
  }
}

/**
 * Hermes 명령어의 전체 경로를 결정합니다.
 * 다음 순서로 검색합니다:
 * - React Native 패키지에 번들된 Hermes
 * - gradle 파일에 지정된 Hermes 명령
 * - node_modules의 hermes-engine 또는 hermesvm
 * @param gradleFile - Gradle 파일 경로
 * @returns Promise<string> - Hermes 명령
 */
async function getHermesCommand(gradleFile: string): Promise<string> {
  const fileExists = (file: string): boolean => {
    try {
      return fs.statSync(file).isFile();
    } catch (e) {
      return false;
    }
  };
  // Hermes is bundled with react-native since 0.69
  const bundledHermesEngine = path.join(getReactNativePackagePath(), "sdks", "hermesc", getHermesOSBin(), getHermesOSExe());
  if (fileExists(bundledHermesEngine)) {
    return bundledHermesEngine;
  }

  const gradleHermesCommand = await getHermesCommandFromGradle(gradleFile);
  if (gradleHermesCommand) {
    return path.join("android", "app", gradleHermesCommand.replace("%OS-BIN%", getHermesOSBin()));
  } else {
    // assume if hermes-engine exists it should be used instead of hermesvm
    const hermesEngine = path.join("node_modules", "hermes-engine", getHermesOSBin(), getHermesOSExe());
    if (fileExists(hermesEngine)) {
      return hermesEngine;
    }
    return path.join("node_modules", "hermesvm", getHermesOSBin(), "hermes");
  }
}

/**
 * React Native의 소스맵 합성 스크립트 경로를 반환합니다.
 * @returns string - 소스맵 합성 스크립트 경로
 */
function getComposeSourceMapsPath(): string {
  // detect if compose-source-maps.js script exists
  const composeSourceMaps = path.join(getReactNativePackagePath(), "scripts", "compose-source-maps.js");
  if (fs.existsSync(composeSourceMaps)) {
    return composeSourceMaps;
  }
  return null;
}

/**
 * Node.js를 사용하여 React Native 패키지의 경로를 반환합니다.
 * @returns string - React Native 패키지 경로
 */
function getReactNativePackagePath(): string {
  const result = childProcess.spawnSync("node", ["--print", "require.resolve('react-native/package.json')"]);
  const packagePath = path.dirname(result.stdout.toString());
  if (result.status === 0 && directoryExistsSync(packagePath)) {
    return packagePath;
  }

  return path.join("node_modules", "react-native");
}

/**
 * 지정된 디렉토리가 존재하는지 확인합니다.
 * @param dirname - 확인할 디렉토리 경로
 * @returns boolean - 디렉토리 존재 여부
 */
export function directoryExistsSync(dirname: string): boolean {
  try {
    return fs.statSync(dirname).isDirectory();
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }
  return false;
}

/**
 * 현재 프로젝트의 React Native 버전을 반환합니다.
 * - 프로젝트의 package.json에서 React Native 버전을 추출합니다.
 * - dependencies 또는 devDependencies에서 react-native 버전을 찾습니다.
 * @returns string - React Native 버전
 */
export function getReactNativeVersion(): string {
  let packageJsonFilename;
  let projectPackageJson;
  try {
    packageJsonFilename = path.join(process.cwd(), "package.json");
    projectPackageJson = JSON.parse(fs.readFileSync(packageJsonFilename, "utf-8"));
  } catch (error) {
    throw new Error(
      `Unable to find or read "package.json" in the CWD. The "release-react" command must be executed in a React Native project folder.`
    );
  }

  const projectName: string = projectPackageJson.name;
  if (!projectName) {
    throw new Error(`The "package.json" file in the CWD does not have the "name" field set.`);
  }

  return (
    (projectPackageJson.dependencies && projectPackageJson.dependencies["react-native"]) ||
    (projectPackageJson.devDependencies && projectPackageJson.devDependencies["react-native"])
  );
}
const { exec } = require("child_process");
const path = require("path");

const scriptPath = path.join(__dirname, "../logger_live.js");

exec(`node ${scriptPath}`, (error, stdout, stderr) => {
  if (error) {
    console.error("실행 중 오류:", error);
    return;
  }
  console.log("실행 결과:", stdout);
});
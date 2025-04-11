/** *  콘솔 로그 수집 + Azure OpenAI 분석 자동화 스크립트 
  
 *  사전 준비: Node.js 설치 (https://nodejs.org/) 

*    설치 확인: node -v, npm -v 
* 
* 프로젝트 준비 
*    1. 빈 폴더 생성 후 본 파일(logger_live.js) 저장 
*    2. 아래 명령어 실행해 필요한 모듈 설치 
*       (해당 파일이 위치한 경로에서 실행해야 함) 
* 
*       npm init -y 
*       npm install puppeteer @azure-rest/ai-inference @azure/core-auth 
*       npm install axios
* 
* 실행 방법 
*       node logger_live.js 
* 동작 설명 
*    - 더현대닷컴 사이트 접속 후 콘솔 오류/경고 및 request 실패 항목 수집 
*    - 수집된 로그는 JSON 파일로 저장됨 
*    - Azure OpenAI GPT-4o API에 분석 요청하여 요약 및 대응방안 자동 분석
*    - 분석 결과는 analysis-result.json 에 저장됨
*
* 생성 파일
*    - console-log-<timestamp>.json: 콘솔 로그 원본
*    - analysis-result.json: Azure AI 분석 결과
*
* 의존 패키지 (설치 명령 참고)
*    - puppeteer
*    - @azure-rest/ai-inference
*    - @azure/core-auth 
*
*   NODE_TLS_REJECT_UNAUTHORIZED=0 설정을 통해 인증서 검증을 우회
*   # Windows
*    set NODE_TLS_REJECT_UNAUTHORIZED=0
*/

process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
// Azure OpenAI API 기반 로그 분석 코드 업데이트
import createClient from "@azure-rest/ai-inference";
import { AzureKeyCredential } from "@azure/core-auth";
import fs from "fs";
import puppeteer from "puppeteer";
import axios from "axios";
import path from "path";

const logCollector = [];

function deduplicateLogs(logs) {
  const seen = new Set(); return logs.filter((log) => {
    const key = `${log.type}||${log.message}||${log.url}||${log.pageUrl}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}


async function extractErrorContextFromStack(stack) {
  try {
    const lines = stack.split("\n");
    for (const line of lines) {
      const match = line.match(/\((https?:\/\/[^\s)]+):(\d+):(\d+)\)/) || 
                    line.match(/at\s+(https?:\/\/[^\s)]+):(\d+):(\d+)/);
      if (match) {
        const [, url, lineStr] = match;
        const lineNumber = parseInt(lineStr, 10);

        const res = await fetch(url);
        if (!res.ok) throw new Error(`파일 요청 실패: ${res.status}`);

        const jsText = await res.text();
        const jsLines = jsText.split("\n");

        const start = Math.max(0, lineNumber - 10);
        const end = Math.min(jsLines.length, lineNumber + 11);

        const snippetLines = jsLines.slice(start, end).map((l, i) => {
          const realLine = start + i + 1;
          const prefix = realLine === lineNumber ? ">>" : "  ";
          return `${prefix} ${realLine.toString().padStart(5)} | ${l}`;
        });

        return {
          url,
          line: lineNumber,
          snippet: snippetLines.join("\n"),
        };
      }
    }
    return { error: "스택에서 JS 경로를 찾지 못함" };
  } catch (err) {
    return { error: `코드 컨텍스트 추출 실패: ${err.message}` };
  }
}

async function extractCodeByLocation(location) {
  try {
    const lineNumber = location.lineNumber ?? 0;
    const res = await fetch(location.url);
    if (!res.ok) throw new Error(`JS 파일 로딩 실패: ${res.status}`);

    const jsText = await res.text();
    const lines = jsText.split("\n");
    console.log("🔥 줄 수:", lines.length);
    console.log("📍 요청한 line:", lineNumber);

    if (lineNumber >= lines.length) {
      return { error: "요청한 줄 번호가 파일 길이를 초과함" };
    }

    const start = Math.max(0, lineNumber - 30);
    const end = Math.min(lines.length, lineNumber + 30);

    const snippet = lines.slice(start, end).map((line, i) => {
      const realLine = start + i + 1;
      const mark = realLine === lineNumber + 1 ? ">>" : "  ";
      return `${mark} ${realLine.toString().padStart(5)} | ${line}`;
    }).join("\n");

    return snippet;
  } catch (err) {
    return `❌ 코드 추출 실패: ${err.message}`;
  }
}



function saveLogs() {

  const dedupedLogs = deduplicateLogs(logCollector);
  const filename = `console-log-${Date.now()}.json`;
  fs.writeFileSync(filename, JSON.stringify(dedupedLogs, null, 2));
  console.log(`로그 저장 완료: ${filename}`);
  return filename;
}

//const axios = require("axios");
//const fs = require("fs");
//const path = require("path");

async function analyzeWithAzureAI(logJsonPath) {
  try {
    const logContent = fs.readFileSync(logJsonPath, "utf-8");
    const logs = JSON.parse(logContent);

    const response = await axios.post(
      "https://console-log-project.azurewebsites.net/api/logger_analyze?code=mkU_yDYMysX6KEmMe0kDzJaj-pn8YhhpctzGNp9Co4ivAzFuvSllxw==",
      {
        logs: logs,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
        timeout: 30000 // (선택) 30초 타임아웃
      }
    );

    const summary = response.data?.summary || "분석 결과 없음";
    const resultFilename = `analysis-result-${Date.now()}.txt`;
    const resultPath = path.join(path.dirname(logJsonPath), resultFilename);

    fs.writeFileSync(resultPath, summary);
    console.log(`✅ 분석 결과 저장 완료: ${resultPath}`);
  } catch (err) {
    console.error("❌ Function App 호출 실패:", err.response?.data || err.message);
  }
} 
(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    args: ["--start-maximized"],
    defaultViewport: { width: 1920, height: 1080 }, //{ width: 1536, height: 737 },
  });
  const page = (await browser.pages())[0];

  /*
  console 예시
  Uncaught TypeError: Cannot read properties of null (reading 'classList')
    at new MobileMenu (cos.custom.js?ver=040715:371:61)
    at window.onload (cos.custom.js?ver=040715:434:10)
  */
  page.on("console", async (msg) => {
    console.log("📦 전체 콘솔 객체:", msg);
    console.log("📜 msg.text():", msg.text());
    console.log("🔍 msg.location():", msg.location());
    console.log("🧩 msg.type():", msg.type());

    const logType = msg.type();
    const message = msg.text().toLowerCase();

    if (logType === "error" || (logType === "warning" && message.includes("deprecated"))) {
      const location = msg.location();
      let codeSnippet = null;

      if (location?.url && typeof location.lineNumber === "number") {
        codeSnippet = await extractCodeByLocation(location);
        console.log("🧩🧩 codeSnippet:", codeSnippet);
      } else {
        const fallback = await extractErrorContextFromStack(msg.text());
        codeSnippet = fallback?.snippet;
        console.log("🧩🧩 codeSnippet:", codeSnippet);
      }



      logCollector.push({
        type: `console-${logType}`,
        message: msg.text(),
        timestamp: new Date().toISOString(),
        url: page.url(),
        ...(codeSnippet && { codeSnippet })
      });
    }
  });



  /*
  pageerror 예시
  Uncaught TypeError: Cannot read properties of null (reading 'classList')
    at new MobileMenu (https://image.thehyundai.com/pc/js/cos/cos.custom.js?ver=040715:371:61)
    at window.onload (https://image.thehyundai.com/pc/js/cos/cos.custom.js?ver=040715:434:10)
  */
  page.on("pageerror", async (err) => {
    const message = err.message.toLowerCase();
  
    // 심각한 에러가 아닌 경우 무시 (선택)
    //sif (!message.includes("uncaught") && !message.includes("is not defined")) return;
  
    console.log("🔥 PAGE ERROR STACK:\n", err.stack);
  
    // 🔍 스택에서 코드 위치 기반 코드 스니펫 추출
    const context = await extractErrorContextFromStack(err.stack);
  
    const logData = {
      type: "pageerror",
      message: err.message,
      timestamp: new Date().toISOString(),
      pageUrl: page.url(),
    };
  
    // context.snippet이 있으면 포함
    if (context?.snippet) {
      logData.codeSnippet = context.snippet;
      logData.codeUrl = context.url;
      logData.codeLine = context.line;
    } else if (context?.error) {
      logData.codeSnippet = context.error;
    }
  
    // (선택) 스크린샷 캡처 비활성화 상태 유지
    /*
    const timestamp = Date.now();
    const screenshotPath = `pageerror-screenshot-${timestamp}.png`;
    await page.setViewport({ width: 1280, height: 720 });
    await page.waitForSelector("body", { visible: true });
    await page.screenshot({ path: screenshotPath });
    logData.screenshot = screenshotPath;
    */
  
    logCollector.push(logData);
  });

  

  page.on("requestfailed", async (req) => {
  try {
    const failedUrl = req.url();
    const hostname = new URL(failedUrl).hostname;
    const excludedDomains = [
      "analytics.google.com",
      "www.google-analytics.com",
      "cm.g.doubleclick.net"
    ];

    if (excludedDomains.includes(hostname)) return;

    const timestamp = new Date().toISOString();

    // (옵션) 스크린샷
    /*
    const screenshotPath = `requestfail-screenshot-${Date.now()}.png`;
    await page.setViewport({ width: 1280, height: 720 });
    await page.waitForSelector("body", { visible: true });
    await page.screenshot({ path: screenshotPath });
    */

    logCollector.push({
      type: "request-failed",
      message: req.failure()?.errorText || "Unknown failure",
      url: failedUrl,
      timestamp,
      pageUrl: page.url(),
      // screenshot: screenshotPath
    });
  } catch (e) {
    logCollector.push({
      type: "request-failed",
      message: req.failure()?.errorText || "Unknown failure",
      url: req.url(),
      timestamp: new Date().toISOString(),
      pageUrl: page.url(),
      note: "URL 파싱 실패, 필터 예외 처리됨"
      // screenshot: screenshotPath
    });
  }
});

  // page.on("console", (msg) => {
  //   const logType = msg.type(); // 'log', 'warning', 'error', 등
  //   const message = msg.text().toLowerCase(); // 소문자로 변환해서 비교
  //   if (
  //     logType === "error" ||
  //     (logType === "warning" && message.includes("deprecated"))
  //   ) {
  //     logCollector.push({
  //       type: `console-${logType}`,
  //       message: msg.text(),
  //       timestamp: new Date().toISOString(),
  //       url: page.url(),
  //     });
  //   }
  // });


  // page.on("pageerror", (err) =>
  //   logCollector.push({
  //     type: "pageerror",
  //     message: err.message,
  //     timestamp: new Date().toISOString(),
  //     url: page.url(),
  //   })
  // );
  // page.on("requestfailed", (req) => {
  //   try {
  //     const failedUrl = req.url();
  //     const hostname = new URL(failedUrl).hostname;
  //     const excludedDomains = ["analytics.google.com", "www.google-analytics.com"];
  //     if (!excludedDomains.includes(hostname)) {
  //       logCollector.push({
  //         type: "request-failed",
  //         message: req.failure().errorText,
  //         url: failedUrl,
  //         timestamp: new Date().toISOString(),
  //         pageUrl: page.url(),
  //       });
  //     }
  //   } catch (e) {
  //     // URL 파싱 실패시에도 안전하게 로그 수집 (optional fallback)
  //     logCollector.push({
  //       type: "request-failed",
  //       message: req.failure().errorText,
  //       url: req.url(),
  //       timestamp: new Date().toISOString(),
  //       pageUrl: page.url(),
  //       note: "URL 파싱 실패, 필터 예외 처리됨",
  //     });
  //   }
  // });


  try {

    await page.goto("https://thehyundai.com/front/dpa/cosHome.thd", { waitUntil: "domcontentloaded" });

    await page.waitForSelector("a.font_small_s_semibold[href*='cosItemList.thd?sectId=']");

    const categoryUrls = await page.
      $$eval("a.font_small_s_semibold[href*='cosItemList.thd?sectId=']", (els) =>
        els.map((el) => el.href.startsWith("http") ? el.href : `https://www.thehyundai.com${el.getAttribute("href")}`)
      );


    // clothing 카테고리 페이지 전체방문
    for (const url of categoryUrls) {
      console.log(`이동: ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await new Promise((resolve) => setTimeout(resolve, 1000)); // 1초 대기
    }

    // 랜덤
    // await page.waitForSelector("a.font_small_s_semibold[href*='cosItemList.thd?sectId=']");
    // const clothingCategoryUrl = await page.$$eval("a.font_small_s_semibold[href*='cosItemList.thd?sectId=']", (els) => {
    //   const hrefs = els.map((el) => el.href.startsWith("http") ? el.href : `https://www.thehyundai.com${el.getAttribute("href")}`);
    //   return hrefs[Math.floor(Math.random() * hrefs.length)];
    // });
    // // await page.goto(clothingCategoryUrl, { waitUntil: "domcontentloaded" });


    // for (const url of categoryUrls) {
    //   console.log(`이동: ${url}`);
    //   await page.goto(url, { waitUntil: "domcontentloaded" });
    //   await new Promise((resolve) => setTimeout(resolve, 1000)); //대기
    // }



    let productUrl;
    const hasIframe = await page.$("iframe#sisFrame");


    if (hasIframe) {
      const frameHandle = await page.$("iframe#sisFrame");
      const frame = await frameHandle.contentFrame();
      await frame.waitForSelector(".o-product a");
      const productLinks = await frame.$$eval(".o-product a", (els) => els.map((el) => el.href));
      productUrl = productLinks[Math.floor(Math.random() * productLinks.length)];
    } else {
      await page.waitForSelector(".o-product a");
      const productLinks = await page.$$eval(".o-product a", (els) => els.map((el) => el.href));
      productUrl = productLinks[Math.floor(Math.random() * productLinks.length)];
    }


    productUrl = productUrl.replace("/sis/", "/front/");
    await page.goto(productUrl, { waitUntil: "domcontentloaded" });


    const hasSize = await page.$(".a-size-swatch .size-options.pdp.in-stock") || await page.$(".a-size-swatch .size-options.pdp.free-size");
    if (!hasSize) throw new Error("사이즈 선택 요소를 찾을 수 없습니다.");


    const sizeOptions = await page.$$eval(".a-size-swatch .size-options.pdp", (elements) => {
      return elements.map((el) => ({
        slitmCd: el.getAttribute("slitm-cd"),
        uitmCd: el.getAttribute("uitm-cd"),
        label: el.innerText.trim(),
      }));
    });


    if (sizeOptions.length > 0) {
      const randomSize = sizeOptions[Math.floor(Math.random() * sizeOptions.length)];
      await page.evaluate((label) => {
        const all = Array.from(document.querySelectorAll(".a-size-swatch .size-options.pdp span"));
        const target = all.find(el => el.innerText.trim() === label);
        if (target) target.click();
      }, randomSize.label);
    }


    await page.waitForSelector("#addBagBtn:not([outofstock='true'])");
    await page.click("#addBagBtn");


    await page.waitForSelector("#nav-bag-desktop");
    await page.click("#nav-bag-desktop");


    await page.waitForSelector(".btn-wrap a.btn");
    await page.click(".btn-wrap a.btn");


    // 로그인 팝업 제어
    const pagesAfterPopup = await browser.pages();
    const loginPage = pagesAfterPopup.find(p => p !== page);
    if (!loginPage) throw new Error("로그인 팝업을 찾을 수 없습니다.");
    await loginPage.bringToFront();


    await loginPage.waitForSelector("#btn-go-thdLogin", { visible: true });
    await loginPage.evaluate(() => document.getElementById("btn-go-thdLogin").click());
    await loginPage.type("input[name='id']", "1234@gmail.com");
    await loginPage.type("input[name='pwd']", "1234");
    await loginPage.evaluate(() => memberLogin());
    await new Promise(r => setTimeout(r, 5000));  // 로그인 대기


    await page.bringToFront(); // 기존 주문 페이지로 복귀
    await page.reload({ waitUntil: "domcontentloaded" });  // 로그인 상태 반영


    await page.waitForSelector("#restPayRadio", { visible: true, timeout: 10000 });
    await page.evaluate(() => {
      document.querySelector("#restPayRadio").scrollIntoView({ behavior: "instant", block: "center" });
    });


    await page.click("#restPayRadio");


    // 무통장입금 선택이 이미 되어 있다면 클릭 생략
    const isCashChecked = await page.$eval("input[name='pay-depth1'][value='cash']", el => el.checked);
    if (!isCashChecked) {
      await page.click("input[name='pay-depth1'][value='cash']");
    }


    await page.waitForSelector("#ordAgreeChk");
    await page.click("#ordAgreeChk");


    await Promise.all([
      page.waitForNavigation({ timeout: 60000, waitUntil: "networkidle2" }),
      page.evaluate(() => {
        const orderBtn = document.querySelector("a.btn.color2.size7");
        if (orderBtn) orderBtn.click();  // onclick="order(this)" 트리거됨
      }),
    ]);

    // 주문 내역 페이지로 이동
    await page.goto("https://www.thehyundai.com/front/mpa/selectOrdDlvCrst.thd", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("a.btn.size1.color7");
    const cancelUrls = await page.$$eval("a.btn.size1.color7", els => els.map(el => el.href));
    const latestCancelUrl = cancelUrls[0];


    await page.goto(latestCancelUrl, { waitUntil: "domcontentloaded" });


    // 수량 저장 클릭
    await page.waitForFunction(() => typeof fnOrdCnclQtyChg === 'function');
    await page.evaluate(() => fnOrdCnclQtyChg());


    // 단순변심 선택
    await page.select("select[name='cnslInqr']", "010105");


    // 주문취소 버튼 클릭 전 팝업 처리기 등록
    page.on("dialog", async (dialog) => {
      console.log("알림 팝업 확인:", dialog.message());
      await dialog.accept();
    });


    // 주문취소 버튼 클릭
    await page.click("#btnOrdCnclReq");


    // 로그아웃 수행
    //await page.goto("https://www.thehyundai.com/front/member/logout.thd", { waitUntil: "domcontentloaded" });
    const savedLog = saveLogs();
    await analyzeWithAzureAI(savedLog);
  } catch (err) {
    console.error("테스트 도중 오류 발생:", err.message);
    const savedLog = saveLogs();
    await analyzeWithAzureAI(savedLog);
  }

  await browser.close();
})();




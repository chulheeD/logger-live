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
*       node logger_live.js --brand=cos
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

        const start = Math.max(0, lineNumber - 40);
        const end = Math.min(jsLines.length, lineNumber + 40);

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

    if (lineNumber >= lines.length) {
      return { error: "요청한 줄 번호가 파일 길이를 초과함" };
    }

    const start = Math.max(0, lineNumber - 40);
    const end = Math.min(lines.length, lineNumber + 40);

    const snippet = lines.slice(start, end).map((line, i) => {
      const realLine = start + i + 1;
      const mark = realLine === lineNumber + 1 ? ">>" : "  ";
      return `${mark} ${realLine.toString().padStart(5)} | ${line}`;
    }).join("\n");

    return snippet;
  } catch (err) {
    return `코드 추출 실패: ${err.message}`;
  }
}



function saveLogs() {

  const dedupedLogs = deduplicateLogs(logCollector);
  const filename = `console-log-${Date.now()}.json`;
  fs.writeFileSync(filename, JSON.stringify(dedupedLogs, null, 2));
  console.log(`로그 저장 완료: ${filename}`);
  return filename;
}

function setupLogHandlers(page) {
  /*
  console 예시
  Uncaught TypeError: Cannot read properties of null (reading 'classList')
    at new MobileMenu (cos.custom.js?ver=040715:371:61)
    at window.onload (cos.custom.js?ver=040715:434:10)
  */
    page.on("console", async (msg) => {
      console.log("전체 콘솔 객체:", msg);
      console.log("msg.text():", msg.text());
      console.log("msg.location():", msg.location());
      console.log("msg.type():", msg.type());
  
      const logType = msg.type();
      const message = msg.text().toLowerCase();
  
      if (logType === "error" || (logType === "warning" && message.includes("deprecated"))) {
        const location = msg.location();
        let codeSnippet = null;
  
        if (location?.url && typeof location.lineNumber === "number") {
          codeSnippet = await extractCodeByLocation(location);
          console.log("codeSnippet:", codeSnippet);
        } else {
          const fallback = await extractErrorContextFromStack(msg.text());
          codeSnippet = fallback?.snippet;
          console.log("codeSnippet:", codeSnippet);
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
    
      console.log("PAGE ERROR STACK:\n", err.stack);
    
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
}

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
    console.log(`분석 결과 저장 완료: ${resultPath}`);
  } catch (err) {
    console.error("Function App 호출 실패:", err.response?.data || err.message);
  }
} 

async function tryAddToCartFromCosCategory(page) {

  // 카테고리 내 상품 리스트 로딩
  let productLinks = [];

  const frameHandle = await page.$("iframe#sisFrame");

  if (frameHandle) {
    try {
      const frame = await frameHandle.contentFrame();
      if (!frame) {
        console.warn("iframe은 존재하지만 아직 attach되지 않았습니다. 일반 페이지로 처리합니다.");
      } else {
        await frame.waitForSelector(".o-product a", { timeout: 3000 });
        productLinks = await frame.$$eval(".o-product a", els => els.map(el => el.href));
      }
    } catch (err) {
      console.error("iframe 접근 중 오류 발생 (frame detached 가능성):", err.message);
    }
  }

  if (productLinks.length === 0) {
    // iframe이 없었거나 frame 접근 실패 → 일반 페이지에서 시도
    try {
      await page.waitForSelector(".o-product a", { timeout: 3000 });
      productLinks = await page.$$eval(".o-product a", els => els.map(el => el.href));
    } catch (err) {
      console.error("일반 페이지에서 상품 추출 실패:", err.message);
    }
  }


  // 랜덤 상품 선택
  if (productLinks.length === 0) {
    console.error("상품 리스트 없음");
    return;
  }

  const randomLink = productLinks[Math.floor(Math.random() * productLinks.length)].replace("/sis/", "/front/");
  console.log(`상품 페이지로 이동: ${randomLink}`);
  await page.goto(randomLink, { waitUntil: "domcontentloaded" });

  
  const sizeOptions = await page.$$eval(".a-size-swatch .size-options.pdp", (elements) =>
  elements
    .filter(el => {
      const classList = el.className;
      return (classList.includes("in-stock") || classList.includes("free-size")) && el.offsetParent !== null;
    })
    .map(el => {
      const span = el.querySelector("span");
      return {
        slitmCd: el.getAttribute("slitm-cd"),
        uitmCd: el.getAttribute("uitm-cd"),
        label: span?.innerText.trim(),
      };
    })
  );
  if (sizeOptions.length === 0) {
    await page.goBack(); // 또는 재귀
    return await tryAddToCartFromCosCategory(page);
  }
  
  // ▶ 랜덤 사이즈 선택 및 클릭
  const selectedSize = sizeOptions[Math.floor(Math.random() * sizeOptions.length)];
  
  await page.evaluate((label) => {
    const sizeSpans = Array.from(document.querySelectorAll(".a-size-swatch .size-options.pdp span"));
    const target = sizeSpans.find(el => el.innerText.trim() === label);
    if (target) target.click();
  }, selectedSize.label);
  
  await page.waitForSelector("#addBagBtn:not([outofstock='true'])", { timeout: 3000 });
  await page.click("#addBagBtn");
}

// --- 브랜드별 테스트 실행 함수 ---
async function runCosTest(page, browser) {
  console.log("COS 사이트 테스트 시작");

  await page.goto("https://www.thehyundai.com/front/dpa/cosHome.thd", { waitUntil: "domcontentloaded" });

  await page.waitForSelector("a.font_small_s_semibold[href*='cosItemList.thd?sectId=']");

  const categoryUrls = await page.
    $$eval("a.font_small_s_semibold[href*='cosItemList.thd?sectId=']", (els) =>
      els.map((el) => el.href.startsWith("http") ? el.href : `https://www.thehyundai.com${el.getAttribute("href")}`)
    );

  
  // 검색창 열기
  await page.waitForSelector("#open-search", { visible: true });
  await page.click("#open-search");

  // 추천 검색어 href 수집 (숫자로 시작하는 ID 이스케이프)
  await page.waitForSelector("#\\35 -trend li a");
  const hrefs = await page.$$eval("#\\35 -trend li a", els => els.map(el => el.getAttribute("href")));

  const baseUrl = "https://www.thehyundai.com";
  if (hrefs.length >= 2) {
    for (let i = 0; i < 2; i++) {
      const searchUrl = hrefs[i].startsWith("http") ? hrefs[i] : `${baseUrl}${hrefs[i]}`;
      console.log(`추천 검색어 ${i + 1}로 이동: ${searchUrl}`);
      await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 다시 검색창 열기
      await page.waitForSelector("#open-search", { visible: true });
      await page.click("#open-search");
      await page.waitForSelector("#\\35 -trend li a");
    }
  }

  // clothing 카테고리 페이지 전체방문
  // clothing 카테고리 페이지 최대 2번만 방문
  const maxVisits = 2;

  for (let i = 0; i < Math.min(maxVisits, categoryUrls.length); i++) {
    
    const url = categoryUrls[i];
    console.log(`이동: ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await new Promise(resolve => setTimeout(resolve, 1000)); // 1초 대기
  }

  // clothing 카테고리 페이지에서 랜덤 상품 선택
  await tryAddToCartFromCosCategory(page);

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
  // 더현대닷컴 계정 입력
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


  // 주문취소 버튼 클릭 전 팝업 처리
  page.on("dialog", async (dialog) => {
    console.log("알림 팝업 확인:", dialog.message());
    await dialog.accept();
  });


  // 주문취소 버튼 클릭
  await page.click("#btnOrdCnclReq");


  // 로그아웃 수행
  //await page.goto("https://www.thehyundai.com/front/member/logout.thd", { waitUntil: "domcontentloaded" });
  const savedLog = saveLogs();
  //await analyzeWithAzureAI(savedLog);
  

  await browser.close();
}

async function runArketTest(page, browser) {
  console.log("아르켓 사이트 테스트 시작");
}

async function runThehyundaiTest(page, browser) {
  console.log("더현대닷컴 사이트 테스트 시작");

  await page.goto("https://www.thehyundai.com/Home.html", { waitUntil: "domcontentloaded" });


  await visitThreeRandomHyundaiUrls(page);

  async function visitThreeRandomHyundaiUrls(page) {
    const gnbItems = await page.$$('.top-nav-area2 > ul > li');

    for (const item of gnbItems) {
      await item.hover();
      await page.waitForTimeout(300); 
    }

    const allUrls = await page.$$eval('.in-cate-area a[href]', links =>
      links.map(a => a.href).filter(href => href.includes('www.thehyundai.com'))
    );

    console.log('전체 추출된 www.thehyundai.com URL 수:', allUrls.length);

    const selected = [];
    while (selected.length < 3 && allUrls.length > 0) {
      const randIdx = Math.floor(Math.random() * allUrls.length);
      const randUrl = allUrls[randIdx];
      if (!selected.includes(randUrl)) {
        selected.push(randUrl);
      }
    }

    for (let i = 0; i < selected.length; i++) {
      const url = selected[i];
      console.log(`🔹 [${i + 1}/3] 이동: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000); // 추가 대기
    }
    
  }

  await page.waitForSelector('#cs-token-input', { visible: true });
  await page.click('#cs-token-input');

  await page.waitForSelector('.popular-list li a', { visible: true });
  const popularKeywords = await page.$$eval('.popular-list li a span', spans =>
    spans.slice(0, 3).map(span => span.textContent.trim())
  );

  console.log(`수집된 인기 검색어: ${popularKeywords.join(', ')}`);

  let addedToCart = false;

  for (const keyword of popularKeywords) {
    await page.click('#cs-token-input', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type('#cs-token-input', keyword);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.click('#cs-search-input')
    ]);

    console.log(`'${keyword}' 검색 완료`);

    // 상품 링크 수집
    const productHrefs = await page.$$eval('.product-list.type1 li .img > a', as =>
      as.map(a => a.getAttribute('href')).filter(href => href?.startsWith('/front/pda/itemPtc.thd'))
    );

    if (productHrefs.length === 0) {
      console.log('검색 결과에 상품이 없습니다.');
      continue;
    }

    const fullUrl = `https://www.thehyundai.com${productHrefs[0]}`;
    console.log('상품 상세 페이지 이동:', fullUrl);
    await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });

    try {
      // 사이즈 드롭다운 열기 시도
      await page.waitForSelector('.opt-select-value a', { visible: true, timeout: 3000 });
      await page.click('.opt-select-value a');
      console.log('사이즈 드롭다운 클릭');

      // 선택 가능한 사이즈 확인
      await page.waitForSelector('.opt-select-layer .depth-opt-list li[stckyn="Y"]', { visible: true, timeout: 3000 });

      const sizeOptions = await page.$$eval('.opt-select-layer .depth-opt-list li[stckyn="Y"]', els =>
        els.map(el => {
          const name = el.querySelector('.opt-name')?.innerText.trim();
          return {
            label: name,
            selector: `li[stckyn="Y"][totseq="${el.getAttribute('totseq')}"] a`
          };
        })
      );

      if (sizeOptions.length > 0) {
        console.log(`선택 가능한 사이즈: ${sizeOptions.map(opt => opt.label).join(', ')}`);

        await page.click(sizeOptions[0].selector);
        console.log(`사이즈 '${sizeOptions[0].label}' 선택`);
        await page.waitForTimeout(1000); // 추가 대기

        // 팝업 처리 등록
        page.on('dialog', async dialog => {
          console.log(`팝업 감지됨: ${dialog.message()}`);
          await dialog.accept();
          console.log('팝업 확인 클릭 완료');
        });

        await page.click('button.btn.size6.color17');
        console.log('장바구니 담기 버튼 클릭 완료');


        await page.waitForTimeout(1500);


        console.log('장바구니 페이지로 이동 완료');

        break; // 성공했으면 종료
      } else {
        console.log('선택 가능한 사이즈 없음');
      }

    } catch (err) {
      console.log('사이즈 선택 실패 또는 드롭다운 열기 실패');
    }
  }

  if (!addedToCart) {
    console.log('모든 검색어에서 구매 가능한 상품을 찾지 못했습니다.');
  }

  await page.waitForSelector(".btn-wrap a.btn");
  await page.click(".btn-wrap a.btn");


  // 로그인 팝업 제어
  await page.waitForTimeout(1500);
  const pagesAfterPopup = await browser.pages();
  const loginPage = pagesAfterPopup.find(p => p !== page);
  if (!loginPage) throw new Error("로그인 팝업을 찾을 수 없습니다.");
  await loginPage.bringToFront();


  await loginPage.waitForSelector("#btn-go-thdLogin", { visible: true });
  await loginPage.evaluate(() => document.getElementById("btn-go-thdLogin").click());
  // 더현대닷컴 계정 입력
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


  // 주문취소 버튼 클릭 전 팝업 처리
  page.on("dialog", async (dialog) => {
    console.log("알림 팝업 확인:", dialog.message());
    await dialog.accept();
  });


  // 주문취소 버튼 클릭
  await page.click("#btnOrdCnclReq");


  // 로그아웃 수행
  await page.goto("https://www.thehyundai.com/front/member/logout.thd", { waitUntil: "domcontentloaded" });
  
  await browser.close();
}

async function runOtherstoriesTest(page, browser) {
  console.log("앤아더스토리즈 사이트 테스트 시작");
}

async function runTotemeTest(page, browser) {
  console.log("토템 사이트 테스트 시작");
}

async function runNanushkaTest(page, browser) {
  console.log("나누쉬카 사이트 테스트 시작");
}

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    args: ["--start-maximized"],
    defaultViewport: { width: 1920, height: 1080 }, //{ width: 1536, height: 737 },
  });
  const page = (await browser.pages())[0];

  setupLogHandlers(page);

  const args = process.argv.slice(2);
  const brandArg = args.find(arg => arg.startsWith("--brand="));
  const brand = brandArg ? brandArg.split("=")[1] : null;

  if (!brand) {
    console.error("브랜드를 입력하세요. 예: --brand=cos");
    process.exit(1);
  }

  try {
    switch (brand.toLowerCase()) {
      case "cos":
        await runCosTest(page, browser);
        break;
      case "arket":
        await runArketTest(page, browser);
        break;
      case "thehyundai":
        await runThehyundaiTest(page, browser);
        break;
      case "otherstories":
        await runOtherstoriesTest(page, browser);
        break;
      case "toteme":
        await runTotemeTest(page, browser);
        break;
      case "nanushka":
        await runNanushkaTest(page, browser);
        break;
      default:
        console.error(`지원하지 않는 브랜드입니다: ${brand}`);
    }

    const savedLog = saveLogs();
    await analyzeWithAzureAI(savedLog);
  } catch (err) {
    console.error("테스트 중 에러 발생:", err.message);
    const savedLog = saveLogs();
    await analyzeWithAzureAI(savedLog);
  }

  await browser.close();
})();

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
// Azure OpenAI API 기반 로그 분석 코드 업데이트
import createClient from "@azure-rest/ai-inference";
import { AzureKeyCredential } from "@azure/core-auth";
import fs from "fs";
import puppeteer from "puppeteer";
import axios from "axios";

const endpoint = "https://ai-chdoo12179135ai766061001285.openai.azure.com";
const deploymentId = "gpt-4o";
const apiKey = "5dWM3YAzhpzJkmJ0RylaW5y3mLfyGTuSaGI2gK93rBBJ8FsLbJF0JQQJ99BDACHYHv6XJ3w3AAAAACOG0BsE";
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

async function analyzeWithAzureAI(logJsonPath) {
  try {
    const client = createClient(endpoint, new AzureKeyCredential(apiKey));
    const logContent = fs.readFileSync(logJsonPath, "utf-8"); // 로그 JSON 불러오기


    const response = await client.path(`/openai/deployments/${deploymentId}/chat/completions`).post({
      body: {
        messages: [
          {
            role
              : "system",
            content
              : "마지막 assistant가 의견을 종합해 최종 분석을 작성 종합해서 분석하되, 반드시 자연어 설명 + 핵심 결과(JSON 형태)를 함께 포함하세요."
          },
          {
            role
              : "assistant",
            content
              : `
          당신은 콘솔 로그 유형을 식별하는 전문가입니다.
               역할: User로 부터 식별 된 전체 로그 각각에 대해 아래 기준으로 설명하세요:
          1. 새로운 유형인지 여부 (과거에 비해 드문지)
          2. 기술적 성격: 네트워크 실패 / JavaScript 오류 / 리소스 누락 등 분류
          3. URL 기준 발생 위치 요약
          4. snippet을 통해 소스 코드 분석
               결과는 JSON 배열 형식으로 작성하세요:
          [
            {
              "newType": true,
              "type": "네트워크 실패",
              "url": "https://example.com/page",
              "Code" " 9165 | \t\t\t\t\t\t}\n    9166 | \t\t\t\t\t};\n    9167 | \t\t\t\t}\n    9168 | \n    9169 | \t\t\t\t// Create the abort callback\n    9170 | \t\t\t\tcallback = callback( \"abort\" );\n    9171 | \n    9172 | \t\t\t\ttry {\n    9173 | \n    9174 | \t\t\t\t\t// Do send the request (this may raise an exception)\n>>  9175 | \t\t\t\t\txhr.send( options.hasContent && options.data || null );\n    9176 | \t\t\t\t} catch ( e ) {\n    9177 | \n    9178 | \t\t\t\t\t// #14683: Only rethrow if this hasn't been notified as an error yet\n    9179 | \t\t\t\t\tif ( callback ) {\n    9180 | \t\t\t\t\t\tthrow e;\n    9181 | \t\t\t\t\t}\n    9182 | \t\t\t\t}\n    9183 | \t\t\t},\n    9184 | \n    9185 | \t\t\tabort: function() {""
            },
            ...
          ]
          `
          },
          {
            role
              : "assistant",
            content
              : `
          당신은 로그의 실무 중요도를 평가하는 전문가입니다.
               역할: User로 부터 식별 된 전체 로그들에 대한 다음 항목을 작성하세요:
          1. 실제 사이트 기능 또는 사용자 경험에 미치는 영향
          2. 중요도 별점[위험도, 사용자 경험에 미치는 영향, 발생빈도 기반으로 5점 만점으로 소수점 첫째 자리까지 산정하세요. Code(snippet)이 있는 경우 0.6점 가산하시오.]
               평가 이유는 실제 프론트 UI/UX 관점에서 기술적으로 상세히 설명하세요.
          `
          },
          {
            role
              : "assistant",
            content
              : `
          당신은 로그의 기술적 원인을 분석하는 전문가입니다.
               역할: 위의 assistant의 중요도 별점 참고하여 전체 로그 중 가장 중요도 별점이 높은 로그 1개에 대해서만 상세 원인을 분석하세요:
          1. 발생 배경 (예: CDN 오류, JS 예외, 보안 정책 등)
          2. Code(snippet)가 있다면 분석을 통해 근본 원인을 적어주세요. (예: 누락된 리소스, CORS 설정, 404 응답 등)
          3. 반복 가능성 또는 시스템 영향
               가능하면 원인과 관련된 Code(snippet) 분석을 통한 근거를 포함하세요.
          `
          },
          {
            role
              : "assistant",
            content
              : `
          당신은 웹 개발 실무자로서 에러메세지, Code(snippet)를 활용하여 대응 방안을 제시해야 합니다.
               역할: 위 assistant가 선정한 가장 중요도가 높은 하나의 로그에 대해서만 다음 내용을 제안하세요:
          1. 즉각적인 대응 방안 (예: 리소스 경로 점검, CDN 캐시 무효화 등)
          2. 예방을 위한 프론트/백엔드 코드 개선 방안
          3. 대응 예시 (CSS 설정, JS fallback 등 실제 코드로 표현, Code(snippet)이 있다면 해당 부분을 수정하세요.)
               실무자가 보고 바로 이해할 수 있게 명확하고 구체적으로 기술하세요.
          `
          },
          {
            role
              : "assistant",
            content
              : `
          당신은 위의 전문가 의견들을 종합해, **최종 분석 리포트**를 작성해야 합니다.
             역할: 아래 형식으로 작성하세요, 굵기 또한 아래형식을 맞추세요.      핵심 로그 요약까지는 여러개가 나올 수 있고 원인 분석부터는 중요도가 가장 높은 한개에 대해서만 상세 분석하세요 :
             ※ 발생 위치 앞 중요도	이모지	예시 표현
               - 4.5점 이상:🔥
               - 4점 이상:⚠️	
               - 3.5점 이상:ℹ️


          Format은 아래와 같습니다.
  

          ## 📌 핵심 로그 요약(중요도 높은 TOP 3)
    
          1. (중요도 가장 높은 오류) 발생 위치 URL: 
          유형 및 메세지: 
          중요도 별점(숫자와 별 그림, 별점 이유): 
          2. (중요도 두번째 높은 오류) 발생 위치 URL:
          유형 및 메세지: 
          중요도 별점(숫자와 별 그림, 별점 이유): 
          3. (중요도 세번째 높은 오류) 발생 위치 URL:
          발생 위치 URL: 
          유형 및 메세지: 
          중요도 별점(숫자와 별 그림, 별점 이유): 
         

          ## 📌 원인 분석(중요도 높은거 하나만)

          - 발생배경
          - 발생 소스코드(있을 경우에만)
          - 근본 원인
          - 에러 메세지
          - 반복 가능성 및 시스템 영향

          ## 📌 대응 방안(중요도 높은거 하나만)
    
          - 즉각적인 대응 방안
          - 예방을 위한 개선 방안
          - 대응 코드[Code(snippet)가 있으면 소스 코드 부분에 직접 수정해서 보여주세요]
              
          ## 📌 비즈니스 또는 사용자 경험에 미치는 영향까지 언급하세요.(중요도 높은거 하나만)
          `
          },
          {
            role: "user",
            content: `다음 JSON 로그를 자연어 설명과 함께 분석해주세요.
                   로그 데이터: ${logContent}`
          }
        ],
        max_tokens: 9192,
        temperature: 0.7,
        top_p: 1
      }

    });



    // if (response.status !== 200) {
    //   throw new Error(JSON.stringify(response.body.error));     
    // }    
    // const result = response.body.choices[0].message.content;

    const result = response.
      body?.choices?.[0]?.message?.content;


    if (!result) {
      console.error("응답은 200이지만 분석 결과가 없습니다.");
      return;
    }
    const resultFilename = `analysis-result-${Date.now()}.json`;
    fs.writeFileSync(resultFilename, result);  //JSON.stringify(response, null, 2)
    console.log(`분석 결과 저장 완료: ${resultFilename}`);


    const webhookUrl = "https://hyundaideptgroup.webhook.office.com/webhookb2/520fc4c0-e6f3-4160-9800-ce955ea6030a@b91c340d-e605-401e-8ef9-ad107eabeb36/IncomingWebhook/7aa9160784f04c198a24e3bd045ce584/508c3a01-ed0b-4192-b718-4cbeb4f912d3/V2fL776fymW7Qu314kW02uGFHJzKguCfF0OscQGQ1V9Sc1";


    // Teams Webhook으로  전송
    try {
      await axios.post(webhookUrl, {
        text: `[COS_SIS_LOG_ANALYSIS_오늘의 오류]\n\n${result.slice(0, 5000)}${result.length > 5000 ? '...' : ''}`
      });
      console.log("Teams Webhook 전송 완료");
    } catch (webhookErr) {
      console.error("Teams 전송 실패:", webhookErr.message);
    }

  } catch (err) {
    console.error("Azure AI 분석 요청 실패:", err);
  }
} (async () => {
  const browser = await puppeteer.launch({
    headless: false,
    args: ["--start-maximized"],
    defaultViewport: { width: 1536, height: 737 }, //{ width: 1920, height: 1080 },
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
    if (!message.includes("uncaught") && !message.includes("is not defined")) return;
  
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




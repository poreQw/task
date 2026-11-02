(() => {
      const fields = ["employeeName", "assigned", "completed", "unresolved", "learned", "next"];
      const form = document.getElementById("logForm");
      const dateInput = document.getElementById("logDate");
      const statusInput = document.getElementById("logStatus");
      const result = document.getElementById("result");
      const storeKey = "haru-record-work-logs";
      const templateStoreKey = "haru-record-templates";
      const supabaseConfig = window.HARU_SUPABASE_CONFIG || {};
      const supabaseConfigured = Boolean(supabaseConfig.url && supabaseConfig.anonKey);
      const supabaseConfigStarted = Boolean(supabaseConfig.url || supabaseConfig.anonKey);
      let supabaseClient = null;
      let supabaseInitError = "";
      if (supabaseConfigured) {
        try {
          const projectUrl = new URL(supabaseConfig.url);
          if (!["https:", "http:"].includes(projectUrl.protocol)) throw new Error("Supabase URL must use HTTP or HTTPS.");
          if (!window.supabase) throw new Error("Supabase library did not load.");
          supabaseClient = window.supabase.createClient(supabaseConfig.url, supabaseConfig.anonKey);
        } catch (error) {
          supabaseInitError = error.message;
          console.error("Supabase를 초기화하지 못했습니다.", error);
        }
      }
      const authOverlay = document.getElementById("authOverlay");
      const taskList = document.getElementById("taskList");
      const today = new Date();
      let currentTasks = [];
      let logsCache = {};
      let currentUser = null;
      let previewLogData = null;
      let saveInProgress = false;
      const draftSaveTimers = new Map();
      let calendarMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      let selectedDate = "";
      let toastTimer;
      const localDate = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      dateInput.value = localDate;
      document.getElementById("topDate").textContent = new Intl.DateTimeFormat("ko-KR", {
        year: "numeric", month: "long", day: "numeric", weekday: "short"
      }).format(today);

      function getLogs() {
        if (supabaseClient && currentUser) return logsCache;
        try {
          const logs = JSON.parse(localStorage.getItem(storeKey) || "{}");
          if (!logs || typeof logs !== "object" || Array.isArray(logs)) return {};
          return Object.fromEntries(Object.entries(logs).map(([date, log]) => {
            return [date, normalizeLog(log)];
          }));
        } catch (error) {
          console.error("업무일지를 불러오지 못했습니다.", error);
          showToast("저장된 업무일지를 불러오지 못했어요.");
          return {};
        }
      }

      async function persistLog(date, log) {
          const normalized = normalizeLog(log);
          if (supabaseClient && currentUser) {
            const { error } = await supabaseClient.from("daily_logs").upsert({
              user_id: currentUser.id,
              log_date: date,
              content: normalized
            }, { onConflict: "user_id,log_date" });
            if (error) throw error;
            logsCache[date] = normalized;
            return;
          }
          const logs = getLogs();
          logs[date] = normalized;
          localStorage.setItem(storeKey, JSON.stringify(logs));
        }

      async function persistLogs(entries) {
          if (supabaseClient && currentUser) {
            const rows = entries.map(([date, log]) => ({
              user_id: currentUser.id, log_date: date, content: normalizeLog(log)
            }));
            for (let offset = 0; offset < rows.length; offset += 250) {
              const { error } = await supabaseClient.from("daily_logs")
                .upsert(rows.slice(offset, offset + 250), { onConflict: "user_id,log_date" });
              if (error) throw error;
            }
            entries.forEach(([date, log]) => { logsCache[date] = normalizeLog(log); });
            return;
          }
          const logs = getLogs();
          entries.forEach(([date, log]) => { logs[date] = normalizeLog(log); });
          localStorage.setItem(storeKey, JSON.stringify(logs));
        }

      async function deletePersistedLog(date) {
          if (supabaseClient && currentUser) {
            const { error } = await supabaseClient.from("daily_logs")
              .delete().eq("user_id", currentUser.id).eq("log_date", date);
            if (error) throw error;
            delete logsCache[date];
            return;
          }
          const logs = getLogs();
          delete logs[date];
          localStorage.setItem(storeKey, JSON.stringify(logs));
      }

      function normalizeLog(log) {
        const entry = log && typeof log === "object" && !Array.isArray(log) ? log : {};
        const oldCompleted = [entry.work, entry.achievement].filter((value) => typeof value === "string" && value.trim());
        const normalized = {
          employeeName: typeof entry.employeeName === "string" ? entry.employeeName : "",
          assigned: typeof entry.assigned === "string" ? entry.assigned : "",
          completed: typeof entry.completed === "string" ? entry.completed : oldCompleted.join("\n"),
          unresolved: typeof entry.unresolved === "string" ? entry.unresolved : typeof entry.blocker === "string" ? entry.blocker : "",
          learned: typeof entry.learned === "string" ? entry.learned : "",
          next: typeof entry.next === "string" ? entry.next : ""
        };
        normalized.status = entry.status === "완료" || entry.status === "진행 중"
          ? entry.status
          : normalized.completed.trim() && !normalized.unresolved.trim() && !normalized.next.trim() ? "완료" : "진행 중";
        normalized.tasks = Array.isArray(entry.tasks)
          ? entry.tasks.filter((task) => task && typeof task.text === "string" && task.text.trim())
            .map((task) => ({ text: task.text.trim(), done: task.done === true }))
          : normalized.next.split(/\r?\n/).map((text) => text.trim()).filter(Boolean).map((text) => ({ text, done: false }));
        return normalized;
      }

      function dateKey(date) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      }

      function showToast(message) {
        const toast = document.getElementById("toast");
        toast.textContent = message;
        toast.classList.add("show");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
      }

      function getNextTaskText(log) {
        return Array.isArray(log.tasks) && log.tasks.length
          ? log.tasks.map((task) => `${task.done ? "☑" : "☐"} ${task.text}`).join("\n")
          : log.next;
      }

      function makeReport(date, log) {
        const reportDate = date.replaceAll("-", ".");
        const sections = [
          ["① 오늘 지시받은 업무 (今日指派工作)", log.assigned],
          ["② 오늘 완료한 업무 (今日完成工作)", log.completed],
          ["③ 해결하지 못한 문제 (未解决问题)", log.unresolved],
          ["④ 오늘 배운 내용 (今日学习内容)", log.learned],
          ["⑤ 내일 할 일 (明日工作计划)", getNextTaskText(log)]
        ];
        return [
          "일일 업무일지",
          `이름(姓名): ${log.employeeName || "미입력"}    날짜(日期): ${reportDate}    상태: ${log.status}`,
          "━━━━━━━━━━━━━━━━━━━━",
          ...sections.flatMap(([title, value]) => [title, value.trim() || "기록 없음", ""])
        ].join("\n");
      }

      function createPdfBlob(date, log) {
        const pageWidth = 794;
        const pageHeight = 1123;
        const scale = 2;
        const margin = 64;
        const pages = [];
        let canvas;
        let context;
        let y;

        function startPage(isContinuation = false) {
          canvas = document.createElement("canvas");
          canvas.width = pageWidth * scale;
          canvas.height = pageHeight * scale;
          context = canvas.getContext("2d");
          if (!context) throw new Error("PDF 페이지를 그릴 수 없습니다.");
          context.scale(scale, scale);
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, pageWidth, pageHeight);
          context.fillStyle = "#635bdb";
          context.fillRect(margin, 54, 5, 43);
          context.fillStyle = "#20243a";
          context.font = "700 27px sans-serif";
          context.fillText(isContinuation ? "일일 업무일지 (계속)" : "일일 업무일지", margin + 18, 82);
          if (isContinuation) {
            y = 126;
          } else {
            context.fillStyle = "#666b7d";
            context.font = "16px sans-serif";
            context.fillText(`이름(姓名): ${log.employeeName || "미입력"}`, margin, 126, 250);
            context.fillText(`날짜(日期): ${date.replaceAll("-", ".")}`, margin + 280, 126, 150);
            context.fillText(`상태: ${log.status}`, margin + 500, 126, 150);
            context.strokeStyle = "#dedfe8";
            context.lineWidth = 1;
            context.beginPath();
            context.moveTo(margin, 153);
            context.lineTo(pageWidth - margin, 153);
            context.stroke();
            y = 184;
          }
          pages.push(canvas);
        }

        function wrapText(text, maxWidth) {
          const lines = [];
          for (const paragraph of text.split(/\r?\n/)) {
            if (!paragraph) {
              lines.push("");
              continue;
            }
            let line = "";
            for (const character of paragraph) {
              const candidate = line + character;
              if (line && context.measureText(candidate).width > maxWidth) {
                lines.push(line.trimEnd());
                line = character.trim() ? character : "";
              } else {
                line = candidate;
              }
            }
            lines.push(line.trimEnd());
          }
          return lines;
        }

        const sections = [
          ["① 오늘 지시받은 업무 (今日指派工作)", log.assigned],
          ["② 오늘 완료한 업무 (今日完成工作)", log.completed],
          ["③ 해결하지 못한 문제 (未解决问题)", log.unresolved],
          ["④ 오늘 배운 내용 (今日学习内容)", log.learned],
          ["⑤ 내일 할 일 (明日工作计划)", getNextTaskText(log)]
        ];
        startPage();
        sections.forEach(([title, value]) => {
          const lines = wrapText(value.trim() || "기록 없음", pageWidth - margin * 2 - 32);
          if (y + 76 > pageHeight - 70) startPage(true);
          context.fillStyle = "#f0efff";
          context.fillRect(margin, y, pageWidth - margin * 2, 38);
          context.fillStyle = "#5149c6";
          context.font = "700 15px sans-serif";
          context.fillText(title, margin + 12, y + 25);
          y += 54;
          context.fillStyle = "#20243a";
          context.font = "16px sans-serif";
          lines.forEach((line) => {
            if (y + 28 > pageHeight - 70) {
              startPage(true);
              context.fillStyle = "#777d91";
              context.font = "700 12px sans-serif";
              context.fillText(`${title} (계속)`, margin, y);
              y += 24;
              context.fillStyle = "#20243a";
              context.font = "16px sans-serif";
            }
            context.fillText(line, margin + 12, y);
            y += 27;
          });
          y += 20;
        });

        pages.forEach((page, index) => {
          const pageContext = page.getContext("2d");
          pageContext.strokeStyle = "#e9eaf0";
          pageContext.beginPath();
          pageContext.moveTo(margin, pageHeight - 54);
          pageContext.lineTo(pageWidth - margin, pageHeight - 54);
          pageContext.stroke();
          pageContext.fillStyle = "#777d91";
          pageContext.font = "12px sans-serif";
          pageContext.fillText(`${index + 1} / ${pages.length}`, pageWidth - margin - 55, pageHeight - 32);
        });

        const encoder = new TextEncoder();
        const encode = (value) => encoder.encode(value);
        const concatenate = (chunks) => {
          const result = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
          let offset = 0;
          chunks.forEach((chunk) => {
            result.set(chunk, offset);
            offset += chunk.length;
          });
          return result;
        };
        const objects = new Map();
        const pageIds = pages.map((_, index) => 3 + index * 3);
        objects.set(1, encode("<< /Type /Catalog /Pages 2 0 R >>"));
        objects.set(2, encode(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`));
        pages.forEach((page, index) => {
          const pageId = pageIds[index];
          const imageId = pageId + 1;
          const contentId = pageId + 2;
          const jpegData = page.toDataURL("image/jpeg", 0.92).split(",")[1];
          const binary = atob(jpegData);
          const image = new Uint8Array(binary.length);
          for (let byte = 0; byte < binary.length; byte += 1) image[byte] = binary.charCodeAt(byte);
          const content = encode("q\n595.28 0 0 841.89 0 0 cm\n/Im0 Do\nQ");
          objects.set(pageId, encode(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`));
          objects.set(imageId, concatenate([
            encode(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`),
            image,
            encode("\nendstream")
          ]));
          objects.set(contentId, concatenate([encode(`<< /Length ${content.length} >>\nstream\n`), content, encode("\nendstream")]));
        });

        const chunks = [encode("%PDF-1.4\n")];
        const offsets = [0];
        let byteLength = chunks[0].length;
        objects.forEach((body, id) => {
          offsets[id] = byteLength;
          const objectChunks = [encode(`${id} 0 obj\n`), body, encode("\nendobj\n")];
          chunks.push(...objectChunks);
          byteLength += objectChunks.reduce((length, chunk) => length + chunk.length, 0);
        });
        const crossReferenceOffset = byteLength;
        const highestId = Math.max(...objects.keys());
        const crossReference = [`xref\n0 ${highestId + 1}\n`, "0000000000 65535 f \n"];
        for (let id = 1; id <= highestId; id += 1) crossReference.push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
        const trailer = encode(`${crossReference.join("")}trailer\n<< /Size ${highestId + 1} /Root 1 0 R >>\nstartxref\n${crossReferenceOffset}\n%%EOF`);
        chunks.push(trailer);
        return new Blob(chunks, { type: "application/pdf" });
      }

      function downloadPdf() {
        if (!selectedDate || !result.classList.contains("show")) {
          showToast("먼저 업무일지를 저장하거나 지난 기록을 선택해 주세요.");
          return;
        }
        try {
          const pdf = createPdfBlob(selectedDate, previewLogData || getLogs()[selectedDate]);
          const url = URL.createObjectURL(pdf);
          const link = document.createElement("a");
          link.href = url;
          link.download = `업무일지-${selectedDate}.pdf`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          showToast("PDF를 다운로드했습니다. 다운로드 폴더를 확인해 주세요.");
        } catch (error) {
          console.error("PDF 파일을 만들지 못했습니다.", error);
          showToast("PDF를 만들지 못했어요. 브라우저를 새로고침한 뒤 다시 시도해 주세요.");
        }
      }

      function appendToField(fieldId, text) {
        const field = document.getElementById(fieldId);
        const entry = text.trim();
        if (!entry) return;
        field.value = field.value.trim() ? `${field.value.trim()} / ${entry}` : entry;
        resizeEntry(field);
      }

      function resizeEntry(field) {
        field.style.height = "auto";
        field.style.height = `${Math.max(126, field.scrollHeight)}px`;
      }

      function classifyNote(sentence) {
        if (/내일|익일|향후|예정|계획|할\s*일|추진할|진행할|예정이/.test(sentence)) return "next";
        if (/문제|미해결|해결\s*(?:못|되지)|어려움|지연|막힘|오류|장애|불가|필요|부족/.test(sentence)) return "unresolved";
        if (/배웠|배움|배우|학습|교육|숙지|익혔|알게\s*되|이해했|새롭게\s*알/.test(sentence)) return "learned";
        if (/지시|지정|요청|전달받|공유\s*받|할당|맡았/.test(sentence)) return "assigned";
        if (/완료|마무리|작성|제출|진행|처리|참석|확인|검토|수정|공유|정리|지원|관리|조사|분석|개발|제작|배포|응대|보고|수행|회신|설계|구현|테스트|점검|조율|착수/.test(sentence)) return "completed";
        return "";
      }

      function organizeNotes() {
        const notes = document.getElementById("quickNotes");
        const raw = notes.value.trim();
        if (!raw) {
          showToast("먼저 오늘 한 일을 메모해 주세요.");
          notes.focus();
          return;
        }
        const sentences = raw.split(/\n+|(?<=[.!?。；;])\s*/).map((sentence) => sentence.trim()).filter(Boolean);
        const unclassified = [];
        let classifiedCount = 0;
        sentences.forEach((sentence) => {
          const field = classifyNote(sentence);
          if (!field) {
            unclassified.push(sentence);
            return;
          }
          appendToField(field, sentence.replace(/[.!?。；;]+$/, ""));
          classifiedCount += 1;
        });
        notes.value = unclassified.join("\n");
        if (classifiedCount && unclassified.length) {
          showToast(`${classifiedCount}개 문장을 나눴어요. 분류되지 않은 메모는 위에 남겨 뒀어요.`);
        } else if (classifiedCount) {
          showToast(`${classifiedCount}개 문장을 업무일지 항목에 나눴어요.`);
        } else {
          showToast("자동 분류할 수 있는 문장이 없어요. 메모를 직접 항목에 옮겨 주세요.");
        }
        if (classifiedCount) saveDraft();
      }

      function polishText(text) {
        return text.split(/\s*\/\s*/).map((part) => {
          const value = part.trim();
          if (!value || /[.!?。]$/.test(value)) return value;
          if (/^(?:특이사항\s*없음|없음|해당\s*없음)$/.test(value)) return `${value}.`;
          if (/했어요$/.test(value)) return `${value.replace(/했어요$/, "했습니다.")}`;
          if (/했음$/.test(value)) return `${value.replace(/했음$/, "했습니다.")}`;
          if (/해요$/.test(value)) return `${value.replace(/해요$/, "합니다.")}`;
          if (/됐어요$/.test(value)) return `${value.replace(/됐어요$/, "되었습니다.")}`;
          if (/지연됨$/.test(value)) return `${value.replace(/지연됨$/, "지연되었습니다.")}`;
          if (/배움$/.test(value)) return `${value.replace(/배움$/, "배웠습니다.")}`;
          if (/예정$/.test(value)) return `${value}입니다.`;
          if (/완료$/.test(value)) return `${value}했습니다.`;
          if (/(?:작성|검토|수정|정리|확인|조사|분석|공유|제출|처리|관리|준비|참석|지원|개발|설계|구현|테스트|점검|진행|수행|보고|응대|회신)$/.test(value)) return `${value}했습니다.`;
          return `${value}.`;
        }).filter(Boolean).join(" / ");
      }

      function syncTasksFromText() {
        const previous = new Map(currentTasks.map((task) => [task.text, task.done]));
        currentTasks = document.getElementById("next").value.split(/\r?\n/)
          .map((text) => text.trim()).filter(Boolean)
          .map((text) => ({ text, done: previous.get(text) === true }));
        renderTaskList();
      }

      function renderTaskList() {
        taskList.replaceChildren();
        currentTasks.forEach((task, index) => {
          const label = document.createElement("label");
          label.className = `task-item${task.done ? " done" : ""}`;
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = task.done;
          checkbox.setAttribute("aria-label", `${task.text} 완료`);
          checkbox.addEventListener("change", () => {
            currentTasks[index].done = checkbox.checked;
            renderTaskList();
            saveDraft(false);
          });
          const text = document.createElement("span");
          text.textContent = task.text;
          label.append(checkbox, text);
          taskList.append(label);
        });
      }

      function renderDashboard() {
        const logs = getLogs();
        const dates = Object.keys(logs).sort();
        document.getElementById("statTotal").textContent = String(dates.length);
        document.getElementById("statDone").textContent = String(dates.filter((date) => logs[date].status === "완료").length);
        document.getElementById("statProgress").textContent = String(dates.filter((date) => logs[date].status !== "완료").length);
        const dateSet = new Set(dates);
        const dayOffset = dateSet.has(localDate) ? 0 : 1;
        let cursor = new Date(`${localDate}T00:00:00`);
        cursor.setDate(cursor.getDate() - dayOffset);
        let streak = 0;
        while (dateSet.has(dateKey(cursor))) {
          streak += 1;
          cursor.setDate(cursor.getDate() - 1);
        }
        document.getElementById("statStreak").textContent = String(streak);
        const weekStart = new Date(`${localDate}T00:00:00`);
        weekStart.setDate(weekStart.getDate() - 6);
        const weekStartDate = dateKey(weekStart);
        document.getElementById("statWeek").textContent = String(dates.filter((date) => date >= weekStartDate && date <= localDate).length);
        const rows = document.getElementById("recentRows");
        rows.replaceChildren();
        const recentDates = dates.slice().sort((a, b) => b.localeCompare(a)).slice(0, 4);
        if (!recentDates.length) {
          const row = document.createElement("tr");
          const empty = document.createElement("td");
          empty.colSpan = 5;
          empty.className = "empty";
          empty.textContent = "아직 업무일지가 없어요. 새 업무일지를 작성해 보세요.";
          row.append(empty);
          rows.append(row);
          return;
        }
        recentDates.forEach((date) => {
          const log = logs[date];
          const row = document.createElement("tr");
          const dateCell = document.createElement("td");
          dateCell.textContent = new Intl.DateTimeFormat("ko-KR", {
            year: "numeric", month: "long", day: "numeric"
          }).format(new Date(`${date}T00:00:00`));
          const nameCell = document.createElement("td");
          nameCell.textContent = log.employeeName || "이름 미입력";
          const taskCell = document.createElement("td");
          const taskPreview = document.createElement("span");
          taskPreview.className = "recent-task";
          taskPreview.textContent = log.assigned || log.completed || "업무 내용 없음";
          taskCell.append(taskPreview);
          const statusCell = document.createElement("td");
          const status = document.createElement("span");
          status.className = `status-badge${log.status === "완료" ? " complete" : ""}`;
          status.textContent = log.status;
          statusCell.append(status);
          const actionCell = document.createElement("td");
          const openButton = document.createElement("button");
          openButton.type = "button";
          openButton.className = "recent-open";
          openButton.textContent = "보기";
          openButton.addEventListener("click", () => {
            renderLog(date, log);
            showView("reportPanel");
          });
          actionCell.append(openButton);
          row.append(dateCell, nameCell, taskCell, statusCell, actionCell);
          rows.append(row);
        });
      }

      function renderCalendar() {
        const grid = document.getElementById("calendarGrid");
        const logs = getLogs();
        const year = calendarMonth.getFullYear();
        const month = calendarMonth.getMonth();
        document.getElementById("calendarMonth").textContent = new Intl.DateTimeFormat("ko-KR", {
          year: "numeric", month: "long"
        }).format(calendarMonth);
        grid.replaceChildren();
        ["일", "월", "화", "수", "목", "금", "토"].forEach((day) => {
          const label = document.createElement("div");
          label.className = "calendar-weekday";
          label.textContent = day;
          grid.append(label);
        });
        const firstWeekday = new Date(year, month, 1).getDay();
        const dayCount = new Date(year, month + 1, 0).getDate();
        const cellCount = Math.ceil((firstWeekday + dayCount) / 7) * 7;
        for (let cell = 0; cell < cellCount; cell += 1) {
          if (cell < firstWeekday || cell >= firstWeekday + dayCount) {
            grid.append(document.createElement("div"));
            continue;
          }
          const day = cell - firstWeekday + 1;
          const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const button = document.createElement("button");
          button.type = "button";
          button.className = `calendar-day${logs[date] ? " has-log" : ""}${date === dateInput.value ? " selected" : ""}`;
          button.textContent = String(day);
          button.setAttribute("aria-label", `${date}${logs[date] ? " 기록 있음" : ""}`);
          button.addEventListener("click", () => {
            dateInput.value = date;
            dateInput.dispatchEvent(new Event("change"));
          });
          grid.append(button);
        }
      }

      function getTemplates() {
        try {
          const templates = JSON.parse(localStorage.getItem(templateStoreKey) || "[]");
          if (!Array.isArray(templates)) throw new Error("템플릿 데이터 형식이 올바르지 않습니다.");
          return templates.filter((template) => template && typeof template.id === "string" &&
            typeof template.name === "string" && template.fields && typeof template.fields === "object");
        } catch (error) {
          console.error("템플릿을 불러오지 못했습니다.", error);
          showToast("템플릿을 불러오지 못했어요. 저장 데이터를 확인해 주세요.");
          return [];
        }
      }

      function renderTemplates() {
        const select = document.getElementById("templateSelect");
        select.replaceChildren(new Option("템플릿 선택", ""));
        getTemplates().forEach((template) => select.add(new Option(template.name, template.id)));
      }

      function downloadJson(filename, data) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }

      function isValidDateKey(date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
        const parsed = new Date(`${date}T00:00:00`);
        return !Number.isNaN(parsed.getTime()) &&
          `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}` === date;
      }

      function renderLog(date, log) {
        selectedDate = date;
        previewLogData = null;
        dateInput.value = date;
        const normalized = normalizeLog(log);
        currentTasks = normalized.tasks;
        statusInput.value = normalized.status;
        document.getElementById("quickNotes").value = "";
        fields.forEach((field) => {
          const input = document.getElementById(field);
          input.value = normalized[field] || "";
          if (input.tagName === "TEXTAREA") resizeEntry(input);
        });
        document.getElementById("resultDate").textContent = new Intl.DateTimeFormat("ko-KR", {
          year: "numeric", month: "long", day: "numeric"
        }).format(new Date(`${date}T00:00:00`));
        document.getElementById("resultBody").textContent = makeReport(date, normalized);
        result.classList.add("show");
        renderTaskList();
        renderEntries();
      }

      function getFormLog() {
        return {
          ...Object.fromEntries(fields.map((field) => [field, document.getElementById(field).value.trim()])),
          status: statusInput.value
        };
      }

      function previewLog() {
        const date = dateInput.value;
        if (!document.getElementById("employeeName").value.trim()) {
          showToast("이름을 입력해 주세요.");
          document.getElementById("employeeName").focus();
          return;
        }
        if (!date) {
          showToast("날짜를 선택해 주세요.");
          dateInput.focus();
          return;
        }
        syncTasksFromText();
        const log = { ...getFormLog(), tasks: currentTasks };
        selectedDate = date;
        previewLogData = log;
        document.getElementById("resultDate").textContent = new Intl.DateTimeFormat("ko-KR", {
          year: "numeric", month: "long", day: "numeric"
        }).format(new Date(`${date}T00:00:00`));
        document.getElementById("resultBody").textContent = makeReport(date, log);
        result.classList.add("show");
        showView("reportPanel");
        showToast("현재 입력 내용의 미리보기입니다.");
      }

      function startNewLog() {
        const existing = getLogs()[localDate];
        if (existing) {
          renderLog(localDate, existing);
          showView("writeLogPanel");
          showToast("오늘의 업무일지가 이미 있어 기존 기록을 수정할 수 있어요.");
          return;
        }
        form.reset();
        dateInput.value = localDate;
        statusInput.value = "진행 중";
        selectedDate = "";
        previewLogData = null;
        currentTasks = [];
        document.getElementById("quickNotes").value = "";
        hideReport();
        renderTaskList();
        renderEntries();
        showView("writeLogPanel");
      }

      function renderEntries() {
        const logs = getLogs();
        const nameQuery = document.getElementById("filterName").value.trim().toLocaleLowerCase();
        const query = document.getElementById("searchLogs").value.trim().toLocaleLowerCase();
        const from = document.getElementById("filterFrom").value;
        const to = document.getElementById("filterTo").value;
        const statusFilter = document.getElementById("filterStatus").value;
        const allDates = Object.keys(logs).sort((a, b) => b.localeCompare(a));
        const dates = allDates.filter((date) => {
          const log = logs[date];
          const searchable = fields.map((field) => log[field]).join("\n").toLocaleLowerCase();
          return (!nameQuery || log.employeeName.toLocaleLowerCase().includes(nameQuery)) &&
            (!query || searchable.includes(query)) && (!from || date >= from) && (!to || date <= to) &&
            (!statusFilter || log.status === statusFilter);
        });
        const list = document.getElementById("entryList");
        document.getElementById("entryCount").textContent = `${dates.length}/${allDates.length}개`;
        list.replaceChildren();
        if (!dates.length) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = allDates.length ? "조건에 맞는 업무일지가 없어요." : "아직 기록이 없어요.\n첫 업무일지를 남겨 보세요!";
          list.append(empty);
          renderDashboard();
          renderCalendar();
          return;
        }
        dates.forEach((date) => {
          const item = document.createElement("div");
          item.className = `entry${date === selectedDate ? " selected" : ""}`;
          const text = document.createElement("div");
          const dateLabel = document.createElement("div");
          dateLabel.className = "entry-date";
          dateLabel.textContent = new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", weekday: "short" })
            .format(new Date(`${date}T00:00:00`));
          const preview = document.createElement("div");
          preview.className = "entry-preview";
          preview.textContent = `${logs[date].employeeName || "이름 미입력"} · ${logs[date].assigned || logs[date].completed || "업무일지"}`;
          text.append(dateLabel, preview);
          const status = document.createElement("span");
          status.className = `status-badge${logs[date].status === "완료" ? " complete" : ""}`;
          status.textContent = logs[date].status;
          const remove = document.createElement("button");
          remove.className = "entry-delete";
          remove.type = "button";
          remove.setAttribute("aria-label", `${date} 업무일지 삭제`);
          remove.textContent = "×";
          remove.addEventListener("click", async (event) => {
            event.stopPropagation();
            if (!window.confirm("이 업무일지를 삭제할까요?")) return;
            clearTimeout(draftSaveTimers.get(date));
            draftSaveTimers.delete(date);
            try {
              await deletePersistedLog(date);
              if (selectedDate === date) {
                selectedDate = "";
                previewLogData = null;
                hideReport();
                form.reset();
                dateInput.value = date;
              }
              renderEntries();
              showToast("업무일지를 삭제했어요.");
            } catch (error) {
              console.error("업무일지를 삭제하지 못했습니다.", error);
              showToast("삭제하지 못했어요. 로그인과 저장소 연결을 확인해 주세요.");
            }
          });
          item.addEventListener("click", () => {
            renderLog(date, logs[date]);
            showView("reportPanel");
          });
          item.append(text, status, remove);
          list.append(item);
        });
        renderDashboard();
        renderCalendar();
      }

      dateInput.addEventListener("change", () => {
        const date = dateInput.value;
        if (!date) return;
        const existing = getLogs()[date];
        if (existing) renderLog(date, existing);
        else {
          selectedDate = "";
          previewLogData = null;
          currentTasks = [];
          hideReport();
          document.getElementById("quickNotes").value = "";
          fields.slice(1).forEach((field) => { document.getElementById(field).value = ""; });
          statusInput.value = "진행 중";
          dateInput.value = date;
          renderTaskList();
          renderEntries();
        }
      });

      fields.slice(1).forEach((field) => {
        document.getElementById(field).addEventListener("input", (event) => resizeEntry(event.currentTarget));
      });
      fields.forEach((field) => document.getElementById(field).addEventListener("input", () => saveDraft()));
      statusInput.addEventListener("change", () => saveDraft());

      document.getElementById("organizeNotesBtn").addEventListener("click", organizeNotes);
      document.getElementById("polishBtn").addEventListener("click", () => {
        let changed = 0;
        fields.slice(1).forEach((field) => {
          const input = document.getElementById(field);
          const polished = polishText(input.value);
          if (polished !== input.value.trim()) changed += 1;
          input.value = polished;
          resizeEntry(input);
        });
        if (changed) saveDraft();
        showToast(changed ? `${changed}개 항목을 업무일지 문장으로 다듬었어요.` : "다듬을 문장이 없거나 이미 문장 형식이에요.");
      });

      async function saveLog(openPdfAfterSave = false) {
        const date = dateInput.value;
        if (saveInProgress) {
          showToast("업무일지를 저장하고 있어요. 잠시만 기다려 주세요.");
          return false;
        }
        if (!document.getElementById("employeeName").value.trim()) {
          showToast("이름을 입력해 주세요.");
          document.getElementById("employeeName").focus();
          return false;
        }
        if (!date) {
          showToast("날짜를 선택해 주세요.");
          dateInput.focus();
          return false;
        }
        const log = getFormLog();
        syncTasksFromText();
        log.tasks = currentTasks;
        saveInProgress = true;
        const saveButtons = [document.getElementById("saveBtn"), document.getElementById("savePdfBtn")];
        saveButtons.forEach((button) => { button.disabled = true; });
        try {
          clearTimeout(draftSaveTimers.get(date));
          draftSaveTimers.delete(date);
          await persistLog(date, log);
          renderLog(date, log);
          showView("reportPanel");
          showToast(currentUser
            ? "업무일지를 서버에 저장했어요."
            : "업무일지를 이 브라우저에 저장했어요. 서버 저장은 로그인해 주세요.");
          if (openPdfAfterSave) downloadPdf();
          return true;
        } catch (error) {
          console.error("업무일지를 저장하지 못했습니다.", error);
          showToast("저장하지 못했어요. 저장 공간이나 연결을 확인해 주세요.");
          return false;
        } finally {
          saveInProgress = false;
          saveButtons.forEach((button) => { button.disabled = false; });
        }
      }

      function saveDraft(updateTasks = true) {
        const date = dateInput.value;
        if (!date) return;
        if (updateTasks) syncTasksFromText();
        const log = getFormLog();
        log.tasks = currentTasks;
        previewLogData = null;
        if (!supabaseClient || !currentUser) {
          const logs = getLogs();
          logs[date] = log;
          try {
            localStorage.setItem(storeKey, JSON.stringify(logs));
          } catch (error) {
            console.error("업무일지를 자동 저장하지 못했습니다.", error);
            showToast("자동 저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.");
          }
        } else {
          logsCache[date] = log;
          clearTimeout(draftSaveTimers.get(date));
          const timer = setTimeout(async () => {
            draftSaveTimers.delete(date);
            try {
              await persistLog(date, log);
            } catch (error) {
              console.error("업무일지 초안을 클라우드에 저장하지 못했습니다.", error);
              showToast("초안을 저장하지 못했어요. 인터넷 연결을 확인해 주세요.");
            }
          }, 600);
          draftSaveTimers.set(date, timer);
        }
        if (selectedDate === date && result.classList.contains("show")) {
          document.getElementById("resultBody").textContent = makeReport(date, log);
        }
        renderEntries();
      }

      form.addEventListener("submit", (event) => {
        event.preventDefault();
        saveLog();
      });
      document.getElementById("savePdfBtn").addEventListener("click", () => saveLog(true));
      document.getElementById("previewBtn").addEventListener("click", previewLog);
      document.getElementById("editReportBtn").addEventListener("click", () => showView("writeLogPanel"));
      document.getElementById("newLogBtn").addEventListener("click", startNewLog);

      document.getElementById("copyBtn").addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(document.getElementById("resultBody").textContent);
          showToast("업무일지를 복사했어요.");
        } catch (error) {
          console.error("클립보드에 복사하지 못했습니다.", error);
          showToast("복사하지 못했어요. 브라우저 권한을 확인해 주세요.");
        }
      });
      document.getElementById("shareBtn").addEventListener("click", async () => {
        if (!selectedDate || !result.classList.contains("show")) {
          showToast("먼저 업무일지를 저장하거나 지난 기록을 선택해 주세요.");
          return;
        }
        const text = document.getElementById("resultBody").textContent;
        if (typeof navigator.share === "function") {
          try {
            await navigator.share({ title: `업무일지-${selectedDate}`, text });
            showToast("공유 메뉴에서 보낼 방법을 선택해 주세요.");
            return;
          } catch (error) {
            if (error.name === "AbortError") return;
            console.error("공유 메뉴를 열지 못했습니다.", error);
          }
        }
        try {
          await navigator.clipboard.writeText(text);
          showToast("업무일지를 복사했어요. 메신저나 메일에 붙여 넣어 보내세요.");
        } catch (error) {
          console.error("업무일지를 공유하거나 복사하지 못했습니다.", error);
          showToast("공유 메뉴를 사용할 수 없어요. 복사 버튼을 사용해 주세요.");
        }
      });
      document.getElementById("downloadBtn").addEventListener("click", () => {
        const content = `${document.getElementById("resultBody").textContent}\n`;
        const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `업무일지-${selectedDate}.txt`;
        link.click();
        URL.revokeObjectURL(url);
      });
      document.getElementById("pdfBtn").addEventListener("click", downloadPdf);

      const navLinks = [...document.querySelectorAll(".nav-link")];
      const main = document.querySelector("main");
      const layout = main.querySelector(".layout");
      const sidebar = layout.querySelector(".sidebar");
      const [dashboardStats, calendar, templates, logList] = sidebar.querySelectorAll(":scope > .archive-card");
      const intro = main.querySelector(".intro");
      const formCard = layout.querySelector(".form-card");
      const recentPanel = main.querySelector(".recent-panel");
      const guide = document.getElementById("guideContent");
      const views = new Map();
      [
        ["dashboardPanel", [intro, dashboardStats, calendar, recentPanel]],
        ["logListPanel", [logList]],
        ["writeLogPanel", [formCard, templates]],
        ["reportPanel", [result]],
        ["guidePanel", [guide]]
      ].forEach(([id, content]) => {
        const view = document.createElement("section");
        view.id = id;
        view.className = "view-panel";
        content.forEach((element) => view.append(element));
        views.set(id, view);
      });
      main.replaceChildren(...views.values());

      const activateNav = (activeLink) => {
        navLinks.forEach((link) => link.classList.toggle("active", link.hash === `#${activeLink}`));
      };
      function showView(viewId, updateHistory = true) {
        const view = views.get(viewId);
        if (!view) return;
        views.forEach((panel) => panel.classList.toggle("active", panel === view));
        activateNav(viewId);
        if (updateHistory) window.history.replaceState(null, "", `#${viewId}`);
      }
      function hideReport() {
        result.classList.remove("show");
        if (location.hash === "#reportPanel") showView("dashboardPanel");
      }
      const initialView = views.has(location.hash.slice(1)) ? location.hash.slice(1) : "dashboardPanel";
      navLinks.forEach((link) => {
        link.addEventListener("click", (event) => {
          const viewId = link.hash.slice(1);
          if (viewId === "reportPanel" && !result.classList.contains("show")) {
            event.preventDefault();
            showToast("먼저 업무일지를 저장하거나 지난 기록을 선택해 주세요.");
            showView("writeLogPanel");
            return;
          }
          event.preventDefault();
          showView(viewId);
        });
      });
      guide.querySelectorAll("[data-guide-view]").forEach((link) => {
        link.addEventListener("click", (event) => {
          event.preventDefault();
          showView(link.dataset.guideView);
        });
      });

      document.getElementById("filterName").addEventListener("input", renderEntries);
      document.getElementById("searchLogs").addEventListener("input", renderEntries);
      document.getElementById("filterFrom").addEventListener("change", renderEntries);
      document.getElementById("filterTo").addEventListener("change", renderEntries);
      document.getElementById("filterStatus").addEventListener("change", renderEntries);
      document.getElementById("calendarPrev").addEventListener("click", () => {
        calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
        renderCalendar();
      });
      document.getElementById("calendarNext").addEventListener("click", () => {
        calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
        renderCalendar();
      });

      document.getElementById("saveTemplateBtn").addEventListener("click", () => {
        const nameInput = document.getElementById("templateName");
        const name = nameInput.value.trim();
        if (!name) {
          showToast("템플릿 이름을 입력해 주세요.");
          nameInput.focus();
          return;
        }
        const templates = getTemplates();
        templates.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: name.trim(),
          fields: Object.fromEntries(fields.slice(1).map((field) => [field, document.getElementById(field).value.trim()]))
        });
        try {
          localStorage.setItem(templateStoreKey, JSON.stringify(templates));
          renderTemplates();
          nameInput.value = "";
          showToast("템플릿을 저장했어요.");
        } catch (error) {
          console.error("템플릿을 저장하지 못했습니다.", error);
          showToast("템플릿을 저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.");
        }
      });
      document.getElementById("applyTemplateBtn").addEventListener("click", () => {
        const template = getTemplates().find((entry) => entry.id === document.getElementById("templateSelect").value);
        if (!template) {
          showToast("먼저 적용할 템플릿을 선택해 주세요.");
          return;
        }
        fields.slice(1).forEach((field) => {
          const input = document.getElementById(field);
          input.value = typeof template.fields[field] === "string" ? template.fields[field] : "";
          if (input.tagName === "TEXTAREA") resizeEntry(input);
        });
        saveDraft();
        showToast("템플릿을 적용했어요.");
      });

      document.getElementById("exportBackupBtn").addEventListener("click", () => {
        try {
          downloadJson(`haru-record-backup-${localDate}.json`, {
            format: "haru-record-backup",
            version: 1,
            exportedAt: new Date().toISOString(),
            logs: getLogs(),
            templates: getTemplates()
          });
          showToast("전체 기록과 템플릿을 백업했어요.");
        } catch (error) {
          console.error("백업을 내보내지 못했습니다.", error);
          showToast("백업 파일을 만들지 못했어요.");
        }
      });
      const backupFile = document.getElementById("backupFile");
      document.getElementById("importBackupBtn").addEventListener("click", () => backupFile.click());
      backupFile.addEventListener("change", async () => {
        const file = backupFile.files[0];
        if (!file) return;
        try {
          if (file.size > 5 * 1024 * 1024) throw new Error("백업 파일은 5MB 이하만 복원할 수 있습니다.");
          const backup = JSON.parse(await file.text());
          if (!backup || backup.format !== "haru-record-backup" || backup.version !== 1 ||
              !backup.logs || typeof backup.logs !== "object" || Array.isArray(backup.logs)) {
            throw new Error("하루기록 백업 파일 형식이 아닙니다.");
          }
          const entries = Object.entries(backup.logs);
          if (entries.some(([date, log]) => !isValidDateKey(date) || !log || typeof log !== "object" || Array.isArray(log))) {
            throw new Error("백업에 잘못된 날짜 또는 기록이 포함되어 있습니다.");
          }
          if (!window.confirm(`${entries.length}개 기록을 복원합니다. 같은 날짜 기록과 같은 ID 템플릿은 백업 내용으로 바뀝니다. 계속할까요?`)) return;
          const normalizedEntries = entries.map(([date, log]) => [date, normalizeLog(log)]);
          await persistLogs(normalizedEntries);
          if (Array.isArray(backup.templates)) {
            const imported = backup.templates.filter((template) => template && typeof template.name === "string" &&
              template.fields && typeof template.fields === "object").map((template) => ({
              id: typeof template.id === "string" ? template.id : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
              name: template.name,
              fields: Object.fromEntries(fields.slice(1).map((field) => [
                field, typeof template.fields[field] === "string" ? template.fields[field] : ""
              ]))
            }));
            const mergedTemplates = new Map(getTemplates().map((template) => [template.id, template]));
            imported.forEach((template) => mergedTemplates.set(template.id, template));
            localStorage.setItem(templateStoreKey, JSON.stringify([...mergedTemplates.values()]));
            renderTemplates();
          }
          const current = getLogs()[dateInput.value];
          if (current) renderLog(dateInput.value, current);
          else renderEntries();
          showToast(`${entries.length}개 기록을 복원했어요.`);
        } catch (error) {
          console.error("백업을 복원하지 못했습니다.", error);
          showToast(error instanceof SyntaxError ? "백업 파일의 JSON 형식을 확인해 주세요." : error.message || "백업을 복원하지 못했어요.");
        } finally {
          backupFile.value = "";
        }
      });

      const authForm = document.getElementById("authForm");
      const authMessage = document.getElementById("authMessage");
      const accountStatus = document.getElementById("accountStatus");
      const storageHelp = document.getElementById("storageHelp");
      const signOutBtn = document.getElementById("signOutBtn");
      const openAuthBtn = document.getElementById("openAuthBtn");
      const authSubmitBtn = document.getElementById("authSubmitBtn");
      const authModeBtn = document.getElementById("authModeBtn");
      const passwordInput = document.getElementById("authPassword");
      const confirmPasswordInput = document.getElementById("confirmPassword");
      const confirmPasswordField = document.getElementById("confirmPasswordField");
      const authMailHelp = document.getElementById("authMailHelp");
      const authEmailInput = document.getElementById("authEmail");
      const resetPasswordBtn = document.getElementById("resetPasswordBtn");
      const resendConfirmationBtn = document.getElementById("resendConfirmationBtn");
      const authCallbackHashParams = new URLSearchParams(window.location.hash.slice(1));
      const authCallbackQueryParams = new URLSearchParams(window.location.search);
      let authCallbackError = authCallbackHashParams.get("error_code") ||
        authCallbackHashParams.get("error") ||
        authCallbackQueryParams.get("error_code") ||
        authCallbackQueryParams.get("error");
      const authTokenHash = authCallbackQueryParams.get("token_hash") ||
        authCallbackHashParams.get("token_hash");
      const authOtpType = authCallbackQueryParams.get("type") || authCallbackHashParams.get("type");
      const hasImplicitAuthCallback = authCallbackHashParams.has("access_token") ||
        authCallbackHashParams.has("refresh_token") ||
        authCallbackQueryParams.has("access_token");
      const hasAuthCallback = Boolean(authCallbackError || authTokenHash || hasImplicitAuthCallback);
      const authRedirectUrl = ["http:", "https:"].includes(window.location.protocol)
        ? new URL(window.location.pathname, window.location.origin).toString()
        : undefined;
      let authReturnFocus = null;
      let authMode = "login";
      const setAccountStatus = (message, state = "local", detail = "") => {
        accountStatus.textContent = message;
        accountStatus.dataset.state = state;
        accountStatus.title = detail ? `${message} · ${detail}` : message;
        if (state === "cloud") {
          storageHelp.textContent = "저장 위치: Supabase 클라우드. 같은 계정으로 로그인한 기기에서 기록을 조회할 수 있습니다.";
        } else if (state === "error") {
          storageHelp.textContent = "클라우드 연결을 확인할 수 없습니다. 로그인 및 저장 상태를 확인한 뒤 백업을 보관하세요.";
        } else if (state === "loading") {
          storageHelp.textContent = "저장 위치를 확인하고 있습니다.";
        } else {
          storageHelp.textContent = "저장 위치: 이 브라우저(로컬). 다른 기기에서 보려면 로그인 후 클라우드에 저장하세요.";
        }
      };
      const setAuthMessage = (message, isError = false) => {
        authMessage.textContent = message;
        authMessage.classList.toggle("error", isError);
      };
      const setAuthBusy = (busy) => {
        authForm.querySelectorAll("input, button").forEach((control) => { control.disabled = busy; });
        if (!busy) {
          authSubmitBtn.disabled = !supabaseClient;
          resetPasswordBtn.disabled = !supabaseClient || authMode !== "login";
          resendConfirmationBtn.disabled = !supabaseClient;
        }
      };
      const closeAuthDialog = () => {
        authOverlay.hidden = true;
        if (authReturnFocus && !authReturnFocus.hidden) authReturnFocus.focus();
      };
      function setAuthMode(mode) {
        authMode = mode;
        const isSignUp = mode === "signup";
        document.getElementById("authTitle").textContent = isSignUp ? "계정 만들기" : "로그인";
        document.getElementById("authDescription").textContent = isSignUp
          ? "이메일과 비밀번호를 등록하세요. 이메일 확인이 필요한 경우 확인 후 로그인할 수 있습니다."
          : "계정에 로그인하면 내 업무일지를 안전하게 저장하고 다른 기기에서도 확인할 수 있습니다.";
        authSubmitBtn.textContent = isSignUp ? "가입하기" : "로그인";
        authModeBtn.textContent = isSignUp ? "이미 계정이 있어요" : "처음 방문하셨나요? 회원가입";
        confirmPasswordField.hidden = !isSignUp;
        confirmPasswordInput.required = isSignUp;
        resetPasswordBtn.hidden = isSignUp;
        resendConfirmationBtn.hidden = true;
        document.getElementById("authPasswordHint").textContent = isSignUp
          ? "비밀번호는 6자 이상이어야 합니다."
          : "비밀번호를 잊으셨다면 이메일로 재설정할 수 있습니다.";
        authMailHelp.hidden = true;
        passwordInput.autocomplete = isSignUp ? "new-password" : "current-password";
        confirmPasswordInput.value = "";
        setAuthBusy(false);
        setAuthMessage("");
      }
      function showAuthCallbackError() {
        setAuthMode("login");
        authOverlay.hidden = false;
        authMailHelp.hidden = false;
        resendConfirmationBtn.hidden = false;
        authReturnFocus = openAuthBtn;
        if (authCallbackError === "otp_expired") {
          setAuthMessage("이메일 확인 링크가 만료되었거나 이미 사용되었습니다. 가입 이메일을 입력하고 확인 이메일을 다시 보내 최신 링크를 열어 주세요.", true);
        } else {
          setAuthMessage("이메일 인증을 완료하지 못했습니다. 가입 이메일을 확인하고 새 확인 이메일을 요청해 주세요.", true);
        }
        authEmailInput.focus();
      }
      function cleanAuthCallbackUrl() {
        window.history.replaceState(null, "", window.location.pathname);
      }
      authModeBtn.addEventListener("click", () => {
        setAuthMode(authMode === "login" ? "signup" : "login");
        passwordInput.focus();
      });
      document.getElementById("togglePasswordBtn").addEventListener("click", (event) => {
        const button = event.currentTarget;
        const reveal = passwordInput.type === "password";
        passwordInput.type = reveal ? "text" : "password";
        button.textContent = reveal ? "숨기기" : "표시";
        button.setAttribute("aria-label", reveal ? "비밀번호 숨기기" : "비밀번호 표시");
      });
      openAuthBtn.hidden = !supabaseConfigStarted;
      openAuthBtn.addEventListener("click", () => {
        setAuthMode("login");
        authReturnFocus = openAuthBtn;
        setAuthMessage(supabaseClient
          ? "로그인하면 업무일지를 계정에 연결해 서버에 저장합니다. 로그인 전에도 앱을 계속 사용할 수 있습니다."
          : supabaseInitError || "Supabase 설정을 확인해 주세요.");
        authOverlay.hidden = false;
        authEmailInput.focus();
      });
      document.getElementById("closeAuthBtn").addEventListener("click", () => {
        closeAuthDialog();
      });
      authOverlay.addEventListener("click", (event) => {
        if (event.target === authOverlay) closeAuthDialog();
      });
      authOverlay.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closeAuthDialog();
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = [...authOverlay.querySelectorAll("button:not(:disabled), input:not(:disabled)")]
          .filter((element) => !element.hidden && element.getClientRects().length);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      });
      resetPasswordBtn.addEventListener("click", async () => {
        if (!supabaseClient) {
          setAuthMessage(supabaseInitError || "Supabase 설정을 확인해 주세요.", true);
          return;
        }
        if (!authEmailInput.value.trim() || !authEmailInput.checkValidity()) {
          setAuthMessage("먼저 입력한 이메일 주소를 확인해 주세요.", true);
          authEmailInput.focus();
          return;
        }
        const email = authEmailInput.value.trim();
        setAuthBusy(true);
        setAuthMessage("재설정 이메일을 요청하고 있습니다...");
        try {
          const { error } = await supabaseClient.auth.resetPasswordForEmail(email);
          if (error) throw error;
          setAuthMessage("해당 이메일이 등록되어 있다면 비밀번호 재설정 안내를 보냈습니다. 받은 편지함을 확인해 주세요.");
        } catch (error) {
          console.error("비밀번호 재설정 이메일을 보내지 못했습니다.", error);
          const message = (error.message || "").toLowerCase();
          if (message.includes("rate limit") || message.includes("too many requests")) {
            setAuthMessage("요청 횟수가 너무 많습니다. 잠시 기다린 뒤 다시 시도해 주세요.", true);
          } else {
            setAuthMessage("재설정 이메일을 보내지 못했습니다. 이메일 주소와 Supabase 설정을 확인해 주세요.", true);
          }
        } finally {
          setAuthBusy(false);
        }
      });
      resendConfirmationBtn.addEventListener("click", async () => {
        if (!supabaseClient) {
          setAuthMessage(supabaseInitError || "Supabase 설정을 확인해 주세요.", true);
          return;
        }
        if (!authEmailInput.value.trim() || !authEmailInput.checkValidity()) {
          setAuthMessage("먼저 가입한 이메일 주소를 확인해 주세요.", true);
          authEmailInput.focus();
          return;
        }
        setAuthBusy(true);
        setAuthMessage("확인 이메일을 요청하고 있습니다...");
        try {
          const { error } = await supabaseClient.auth.resend({
            type: "signup",
            email: authEmailInput.value.trim(),
            options: authRedirectUrl ? { emailRedirectTo: authRedirectUrl } : undefined
          });
          if (error) throw error;
          setAuthMessage("요청을 처리했습니다. 가입한 주소의 받은 편지함과 스팸함을 확인해 주세요. 이미 인증된 계정이라면 바로 로그인해 보세요.");
        } catch (error) {
          console.error("확인 이메일을 다시 보내지 못했습니다.", error);
          const message = (error.message || "").toLowerCase();
          if (error.code === "over_email_send_rate_limit" || message.includes("rate limit") || message.includes("too many requests")) {
            setAuthMessage("이메일 요청 횟수가 너무 많습니다. 잠시 기다린 뒤 다시 시도해 주세요.", true);
          } else {
            setAuthMessage("확인 이메일을 보내지 못했습니다. 잠시 후 다시 시도하거나 Supabase Authentication 설정을 확인해 주세요.", true);
          }
        } finally {
          setAuthBusy(false);
        }
      });
      async function loadCloudLogs(user) {
        const loaded = {};
        for (let offset = 0; ; offset += 1000) {
          const { data, error } = await supabaseClient.from("daily_logs")
            .select("log_date,content").eq("user_id", user.id)
            .order("log_date", { ascending: false }).range(offset, offset + 999);
          if (error) throw error;
          data.forEach((row) => {
            if (isValidDateKey(row.log_date)) loaded[row.log_date] = normalizeLog(row.content);
          });
          if (data.length < 1000) break;
        }
        logsCache = loaded;
        renderEntries();
        const current = loaded[dateInput.value];
        if (current) renderLog(dateInput.value, current);
        else {
          selectedDate = "";
          hideReport();
          renderEntries();
        }
      }

      async function applyAuthSession(session) {
        const user = session && session.user;
        if (!user) {
          const wasSignedIn = Boolean(currentUser);
          draftSaveTimers.forEach((timer) => clearTimeout(timer));
          draftSaveTimers.clear();
          currentUser = null;
          logsCache = {};
          if (wasSignedIn) {
            selectedDate = "";
            form.reset();
            dateInput.value = localDate;
            currentTasks = [];
            hideReport();
            renderTaskList();
          }
          authOverlay.hidden = true;
          signOutBtn.hidden = true;
          openAuthBtn.hidden = !supabaseConfigStarted;
          setAccountStatus("로컬 저장 · 이 브라우저");
          renderEntries();
          if (authCallbackError) showAuthCallbackError();
          return;
        }
        if (currentUser && currentUser.id === user.id) return;
        currentUser = user;
        form.reset();
        dateInput.value = localDate;
        currentTasks = [];
        selectedDate = "";
        hideReport();
        renderTaskList();
        openAuthBtn.hidden = true;
        signOutBtn.hidden = false;
        setAccountStatus(`클라우드 저장 · ${user.email || "Supabase"}`, "cloud");
        setAuthMessage("저장된 업무일지를 불러오는 중...");
        try {
          await loadCloudLogs(user);
          closeAuthDialog();
          authMessage.textContent = "";
        } catch (error) {
          console.error("클라우드 업무일지를 불러오지 못했습니다.", error);
          currentUser = null;
          logsCache = {};
          signOutBtn.hidden = true;
          openAuthBtn.hidden = !supabaseConfigStarted;
          setAccountStatus("클라우드 연결 오류", "error");
          authOverlay.hidden = true;
          renderEntries();
          setAuthMessage("기록을 불러오지 못했습니다. Supabase SQL 설정과 네트워크를 확인해 주세요.");
        }
      }

      authForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!supabaseClient) return;
        const email = document.getElementById("authEmail").value.trim();
        const password = passwordInput.value;
        if (authMode === "signup" && password !== confirmPasswordInput.value) {
          setAuthMessage("비밀번호가 서로 일치하지 않습니다.", true);
          confirmPasswordInput.focus();
          return;
        }
        setAuthBusy(true);
        setAuthMessage(authMode === "signup" ? "계정을 만들고 있습니다..." : "로그인 중...");
        try {
          if (authMode === "signup") {
            const { data, error } = await supabaseClient.auth.signUp({
              email,
              password,
              options: authRedirectUrl ? { emailRedirectTo: authRedirectUrl } : undefined
            });
            if (error) throw error;
            if (data.session) {
              setAuthMessage("가입이 완료되었습니다. 로그인 상태로 전환합니다.");
            } else if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
              setAuthMode("login");
              document.getElementById("authEmail").value = email;
              setAuthMessage("이미 가입된 이메일입니다. 이 계정으로 로그인해 주세요.", true);
            } else {
              setAuthMessage("계정이 생성되었습니다. 이메일 확인이 필요합니다. 확인 메일을 받지 못했다면 다시 보내기를 눌러 주세요.");
              authMailHelp.hidden = false;
              resendConfirmationBtn.hidden = false;
            }
          } else {
            const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
            if (error) throw error;
            setAuthMessage("로그인되었습니다.");
          }
        } catch (error) {
          console.error(authMode === "signup" ? "계정을 만들지 못했습니다." : "로그인하지 못했습니다.", error);
          const message = (error.message || "").toLowerCase();
          const errorCode = (error.code || "").toLowerCase();
          if (errorCode === "email_not_confirmed" || message.includes("email not confirmed") || message.includes("email is not confirmed")) {
            setAuthMessage("계정은 있지만 이메일 인증이 완료되지 않아 로그인할 수 없습니다.", true);
            authMailHelp.hidden = false;
            resendConfirmationBtn.hidden = false;
          } else if (errorCode === "invalid_credentials" || message.includes("invalid login credentials")) {
            setAuthMessage("이메일 또는 비밀번호가 올바르지 않습니다. 가입한 주소와 비밀번호를 확인해 주세요.", true);
          } else if (errorCode === "user_not_found" || message.includes("user not found")) {
            setAuthMessage("가입된 계정을 찾지 못했습니다. 이메일 주소를 확인하거나 다시 가입해 주세요.", true);
          } else if (errorCode === "over_email_send_rate_limit" || message.includes("rate limit") || message.includes("too many requests")) {
            setAuthMessage("요청 횟수가 너무 많습니다. 잠시 기다린 뒤 다시 시도해 주세요.", true);
          } else if (message.includes("already registered") || message.includes("already been registered")) {
            setAuthMessage("이미 가입된 이메일입니다. 로그인해 주세요.", true);
          } else if (message.includes("password") && (message.includes("short") || message.includes("least"))) {
            setAuthMessage("비밀번호가 너무 짧습니다. 6자 이상 입력해 주세요.", true);
          } else if (message.includes("invalid") && message.includes("email")) {
            setAuthMessage("이메일 주소를 확인해 주세요.", true);
          } else if (authMode === "signup") {
            setAuthMessage("가입하지 못했습니다. 입력한 정보를 확인하고 다시 시도해 주세요.", true);
          } else {
            setAuthMessage("로그인하지 못했습니다. 이메일과 비밀번호를 확인해 주세요.", true);
          }
        } finally {
          setAuthBusy(false);
        }
      });

      signOutBtn.addEventListener("click", async () => {
        if (!supabaseClient) return;
        signOutBtn.disabled = true;
        try {
          for (const [date, timer] of draftSaveTimers) {
            clearTimeout(timer);
            draftSaveTimers.delete(date);
            await persistLog(date, logsCache[date]);
          }
          const { error } = await supabaseClient.auth.signOut();
          if (error) throw error;
          await applyAuthSession(null);
          setAuthMessage("로그아웃했습니다.");
        } catch (error) {
          console.error("로그아웃하지 못했습니다.", error);
          showToast("초안 저장 또는 로그아웃에 실패했습니다. 연결을 확인하고 다시 시도해 주세요.");
        } finally {
          signOutBtn.disabled = false;
        }
      });

      async function initializeAuth() {
        if (!supabaseConfigStarted) {
          setAccountStatus("로컬 저장 · 이 브라우저");
          signOutBtn.hidden = true;
          return;
        }
        if (!supabaseConfigured) {
          setAuthMessage("supabase/config.js에 Project URL과 publishable/anon key를 모두 설정해 주세요.");
          setAccountStatus("로컬 저장 · 클라우드 설정 필요", "error");
          return;
        }
        if (!supabaseClient) {
          setAuthMessage(supabaseInitError || "Supabase 연결을 초기화하지 못했습니다. 설정을 확인해 주세요.");
          setAccountStatus("클라우드 연결 오류", "error");
          return;
        }
        setAccountStatus("연결 중...", "loading");
        supabaseClient.auth.onAuthStateChange((_event, session) => {
          setTimeout(() => { applyAuthSession(session); }, 0);
        });
        try {
          let authVerificationSucceeded = false;
          if (authTokenHash) {
            cleanAuthCallbackUrl();
            const supportedOtpTypes = new Set(["signup", "email", "magiclink", "recovery", "invite", "email_change"]);
            if (!supportedOtpTypes.has(authOtpType)) {
              authCallbackError = "invalid_callback";
            } else {
              try {
                const { error } = await supabaseClient.auth.verifyOtp({
                  token_hash: authTokenHash,
                  type: authOtpType
                });
                if (error) throw error;
                authVerificationSucceeded = true;
              } catch (error) {
                console.error("이메일 확인 링크를 검증하지 못했습니다.", error);
                authCallbackError = error.code || "otp_expired";
              }
            }
          }
          const { data, error } = await supabaseClient.auth.getSession();
          if (error) throw error;
          if (data.session) {
            if (hasImplicitAuthCallback) cleanAuthCallbackUrl();
            await applyAuthSession(data.session);
          }
          else {
            setAccountStatus("로컬 저장 · 이 브라우저");
            if (hasImplicitAuthCallback && !authCallbackError) {
              authCallbackError = "invalid_callback";
            }
            if (authCallbackError) {
              cleanAuthCallbackUrl();
              showAuthCallbackError();
            } else if (authVerificationSucceeded) {
              cleanAuthCallbackUrl();
              setAuthMode("login");
              authOverlay.hidden = false;
              authReturnFocus = openAuthBtn;
              setAuthMessage("이메일 확인이 완료되었습니다. 이제 가입한 이메일과 비밀번호로 로그인해 주세요.");
              authEmailInput.focus();
            } else {
              setAuthMessage("로그인 없이 앱을 사용할 수 있습니다. 서버에 저장하려면 로그인하거나 회원가입하세요.");
            }
          }
        } catch (error) {
          console.error("인증 상태를 확인하지 못했습니다.", error);
          setAuthMessage("Supabase에 연결하지 못했습니다. 설정과 네트워크를 확인해 주세요.");
          setAccountStatus("클라우드 연결 오류", "error");
        }
      }

      renderTemplates();
      renderEntries();
      const existingToday = getLogs()[localDate];
      if (existingToday) renderLog(localDate, existingToday);
      showView(initialView === "reportPanel" && !result.classList.contains("show")
        ? "dashboardPanel"
        : initialView, !hasAuthCallback);
      initializeAuth();
    })();

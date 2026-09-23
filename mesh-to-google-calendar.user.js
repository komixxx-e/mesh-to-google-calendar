// ==UserScript==
// @name         МЭШ → Google Календарь
// @namespace    https://github.com/komixxx-e/mesh-to-google-calendar
// @version      3.1.1
// @description  Экспорт расписания уроков и пар СПО (Колледж) из МЭШ (school.mos.ru) напрямую в Google Календарь или в формате .ics
// @author       komixxx-e
// @match        https://school.mos.ru/*
// @match        https://dnevnik.mos.ru/*
// @icon         https://school.mos.ru/favicon.ico
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      googleapis.com
// @connect      google.com
// @require      https://accounts.google.com/gsi/client
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/komixxx-e/mesh-to-google-calendar/main/mesh-to-google-calendar.user.js
// @downloadURL  https://raw.githubusercontent.com/komixxx-e/mesh-to-google-calendar/main/mesh-to-google-calendar.user.js
// ==/UserScript==

(function () {
    'use strict';

    // Дефолтный Client ID (пользователь может переопределить в настройках ⚙️)
    const DEFAULT_CLIENT_ID = '1016021031311-bdcb9jhc82u43tbaj4qmj0357hpms3gf.apps.googleusercontent.com';

    function getClientId() {
        return localStorage.getItem('mesh_google_client_id') || DEFAULT_CLIENT_ID;
    }

    function setClientId(val) {
        localStorage.setItem('mesh_google_client_id', (val || '').trim());
    }

    let collectedLessons = [];
    let googleAccessToken = null;
    let syncMode = localStorage.getItem('mesh_cal_sync_mode') || 'day'; // 'day' или 'lessons'
    let isMinimized = false;
    let isPreviewOpen = false;
    let isSettingsOpen = false;

    // --- Извлечение даты из URL ---
    function getDateFromUrl() {
        const params = new URLSearchParams(window.location.search);
        const d = params.get('date');
        if (d && d.includes('-')) {
            const parts = d.split('-');
            if (parts[0].length === 4) return d;
            if (parts[2].length === 4) return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
        }
        return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
    }

    // --- Надёжное сканирование текста страницы (СПО Колледж & Школа) ---
    function scanPageText() {
        const text = document.body ? document.body.innerText : '';
        if (!text) return;

        const date = getDateFromUrl();
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        const found = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Пропускаем строки перемен/перерывов
            if (/перемена|перерыв/i.test(line)) continue;

            // Поиск временного диапазона HH:MM - HH:MM
            const timeMatch = line.match(/(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/);
            if (!timeMatch) continue;

            const beginTime = timeMatch[1];
            const endTime = timeMatch[2];

            // Проверяем кабинет / аудиторию
            const roomMatch = line.match(/(?:каб\.?|ауд\.?)\s*(?:№\s*)?([A-Za-zА-Яа-я0-9\/\-]+)/i);
            const room = roomMatch ? `каб. № ${roomMatch[1]}` : '';

            // Предмет находится на следующей строке (пропуская служебные строки)
            let subject = '';
            for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
                const nextLine = lines[j];
                if (/перемена|перерыв/i.test(nextLine)) break;
                if (/\d{1,2}:\d{2}\s*[-–—]\s*\d{1,2}:\d{2}/.test(nextLine)) break;
                if (/^(?:каб\.|ауд\.)/i.test(nextLine)) continue;
                if (!subject) {
                    subject = nextLine;
                    break;
                }
            }

            if (subject) {
                found.push({
                    subject: subject,
                    date: date,
                    beginTime: beginTime,
                    endTime: endTime,
                    room: room,
                    teacher: '',
                    topic: '',
                    homework: ''
                });
            }
        }

        if (found.length > 0) {
            addLessons(found);
        }
    }

    function addLessons(newLessons) {
        const map = new Map();
        for (const l of [...collectedLessons, ...newLessons]) {
            let d = l.date;
            if (d && d.includes('.')) {
                const [day, m, y] = d.split('.');
                d = `${y}-${m.padStart(2, '0')}-${day.padStart(2, '0')}`;
            }
            const key = `${d}_${l.beginTime}_${l.endTime}_${l.subject}`;
            map.set(key, { ...l, date: d });
        }
        collectedLessons = Array.from(map.values());
        updateUi();
    }

    function getIsoTime(lesson, type) {
        const isStart = type === 'start';
        const dateStr = lesson.date;
        const timeStr = isStart ? lesson.beginTime : lesson.endTime;
        if (dateStr && timeStr) {
            let y, m, d;
            if (dateStr.includes('-')) [y, m, d] = dateStr.split('-');
            else if (dateStr.includes('.')) [d, m, y] = dateStr.split('.');
            else return null;

            const [hh, mm] = timeStr.split(':');
            return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${hh.padStart(2, '0')}:${(mm || '00').padStart(2, '0')}:00+03:00`;
        }
        return null;
    }

    function buildEventsToSync() {
        if (syncMode === 'lessons') {
            return collectedLessons.map(l => {
                const startIso = getIsoTime(l, 'start');
                const endIso = getIsoTime(l, 'end');
                if (!startIso || !endIso) return null;

                const desc = [];
                if (l.room) desc.push(`🚪 ${l.room}`);

                return {
                    summary: l.room ? `${l.subject} (${l.room})` : l.subject,
                    location: l.room || '',
                    description: desc.join('\n'),
                    start: { dateTime: startIso, timeZone: 'Europe/Moscow' },
                    end: { dateTime: endIso, timeZone: 'Europe/Moscow' }
                };
            }).filter(Boolean);
        } else {
            const days = {};
            collectedLessons.forEach(l => {
                let dateKey = l.date;
                if (!days[dateKey]) days[dateKey] = [];
                days[dateKey].push(l);
            });

            const dayEvents = [];
            Object.keys(days).sort().forEach(dateStr => {
                const dayLessons = days[dateStr];
                // Сортировка по времени начала
                dayLessons.sort((a, b) => (a.beginTime || '').localeCompare(b.beginTime || ''));

                // Ищем самое раннее начало и самое позднее окончание занятий в этот день
                let earliestStartLesson = dayLessons[0];
                let latestEndLesson = dayLessons[0];

                for (const l of dayLessons) {
                    if ((l.beginTime || '') < (earliestStartLesson.beginTime || '')) {
                        earliestStartLesson = l;
                    }
                    if ((l.endTime || '') > (latestEndLesson.endTime || '')) {
                        latestEndLesson = l;
                    }
                }

                const startIso = getIsoTime(earliestStartLesson, 'start');
                const endIso = getIsoTime(latestEndLesson, 'end');
                if (!startIso || !endIso) return;

                const descLines = [`📚 Расписание занятий (${dayLessons.length} пар/уроков):\n`];
                dayLessons.forEach((l, idx) => {
                    const timeStr = l.beginTime && l.endTime ? `${l.beginTime}–${l.endTime}` : '';
                    const roomStr = l.room ? `[${l.room}]` : '';
                    descLines.push(`${idx + 1}. ${timeStr} ${l.subject} ${roomStr}`.trim());
                });

                dayEvents.push({
                    summary: `Учёба (${dayLessons.length} ур.)`,
                    description: descLines.join('\n').trim(),
                    start: { dateTime: startIso, timeZone: 'Europe/Moscow' },
                    end: { dateTime: endIso, timeZone: 'Europe/Moscow' }
                });
            });

            return dayEvents;
        }
    }

    // --- Генерация iCalendar (.ics) файла ---
    function escapeIcs(str) {
        if (!str) return '';
        return str.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    }

    function generateIcsContent() {
        const lines = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//MESH to Google Calendar Exporter//RU',
            'CALSCALE:GREGORIAN',
            'METHOD:PUBLISH',
            'X-WR-CALNAME:Школа (МЭШ)',
            'X-WR-TIMEZONE:Europe/Moscow',
            'BEGIN:VTIMEZONE',
            'TZID:Europe/Moscow',
            'X-LIC-LOCATION:Europe/Moscow',
            'BEGIN:STANDARD',
            'TZOFFSETFROM:+0300',
            'TZOFFSETTO:+0300',
            'TZNAME:MSK',
            'DTSTART:19700101T000000',
            'END:STANDARD',
            'END:VTIMEZONE'
        ];

        const nowIso = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
        const events = buildEventsToSync();

        events.forEach((ev, idx) => {
            const startClean = ev.start.dateTime.replace(/[-:]/g, '').slice(0, 15);
            const endClean = ev.end.dateTime.replace(/[-:]/g, '').slice(0, 15);
            const uid = `mesh-${idx}-${Math.random().toString(36).substring(2, 9)}@mesh`;

            lines.push('BEGIN:VEVENT');
            lines.push(`UID:${uid}`);
            lines.push(`DTSTAMP:${nowIso}`);
            lines.push(`DTSTART;TZID=Europe/Moscow:${startClean}`);
            lines.push(`DTEND;TZID=Europe/Moscow:${endClean}`);
            lines.push(`SUMMARY:${escapeIcs(ev.summary)}`);
            if (ev.location) lines.push(`LOCATION:${escapeIcs(ev.location)}`);
            if (ev.description) lines.push(`DESCRIPTION:${escapeIcs(ev.description)}`);
            lines.push('STATUS:CONFIRMED');
            lines.push('END:VEVENT');
        });

        lines.push('END:VCALENDAR');
        return lines.join('\r\n');
    }

    function downloadIcsFile() {
        if (collectedLessons.length === 0) return;
        const icsData = generateIcsContent();
        const blob = new Blob([icsData], { type: 'text/calendar;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mesh_schedule_${new Date().toISOString().slice(0, 10)}.ics`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // --- Google Calendar API функции ---
    function makeApiRequest(url, method = 'GET', body = null, token = googleAccessToken) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                url: url,
                method: method,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                data: body ? JSON.stringify(body) : null,
                onload: (res) => {
                    if (res.status >= 200 && res.status < 300) {
                        try { resolve(JSON.parse(res.responseText)); } catch (e) { resolve(res.responseText); }
                    } else {
                        reject(new Error(`HTTP ${res.status}: ${res.responseText}`));
                    }
                },
                onerror: reject
            });
        });
    }

    async function getOrCreateSchoolCalendar() {
        const list = await makeApiRequest('https://www.googleapis.com/calendar/v3/users/me/calendarList');
        const cal = list.items && list.items.find(c => c.summary === 'Школа (МЭШ)');
        if (cal) return cal.id;

        const created = await makeApiRequest('https://www.googleapis.com/calendar/v3/calendars', 'POST', {
            summary: 'Школа (МЭШ)',
            timeZone: 'Europe/Moscow',
            description: 'Расписание занятий из МЭШ'
        });
        return created.id;
    }

    async function syncWithGoogle(token) {
        googleAccessToken = token;
        const events = buildEventsToSync();
        if (events.length === 0) return;

        setSyncingState(true, `Подключение к календарю...`, 0);

        try {
            const calId = await getOrCreateSchoolCalendar();
            let addedCount = 0;

            for (let i = 0; i < events.length; i++) {
                const percent = Math.round(((i + 1) / events.length) * 100);
                const unit = syncMode === 'lessons' ? 'пар' : 'дней';
                setSyncingState(true, `Добавлено: ${i + 1} из ${events.length} ${unit}`, percent);

                await makeApiRequest(
                    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`,
                    'POST',
                    events[i]
                );
                addedCount++;
            }

            setSyncSuccess(addedCount);
        } catch (err) {
            console.error(err);
            setSyncingState(false);
            showError(`Ошибка: ${err.message}`);
        }
    }

    function requestGoogleAuth() {
        const clientId = getClientId();
        if (!clientId) {
            isSettingsOpen = true;
            renderCard();
            return;
        }

        const client = google.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope: 'https://www.googleapis.com/auth/calendar',
            callback: (res) => {
                if (res.access_token) {
                    syncWithGoogle(res.access_token);
                } else if (res.error) {
                    showError(`Ошибка авторизации Google: ${res.error_description || res.error}`);
                }
            }
        });
        client.requestAccessToken();
    }

    // --- UI Дизайн и Стили ---
    let widgetEl = null;

    function injectStyles() {
        if (document.getElementById('mesh-cal-styles')) return;
        const style = document.createElement('style');
        style.id = 'mesh-cal-styles';
        style.textContent = `
            #mesh-cal-card * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif; }
            #mesh-cal-card {
                position: fixed;
                bottom: 24px;
                right: 24px;
                z-index: 999999;
                width: 310px;
                background: #ffffff;
                border-radius: 16px;
                box-shadow: 0 16px 36px -4px rgba(15, 23, 42, 0.16), 0 2px 8px rgba(15, 23, 42, 0.06);
                border: 1px solid rgba(226, 232, 240, 0.95);
                overflow: hidden;
                transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
            }
            .mesh-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 12px 16px;
                background: #fafbfc;
                border-bottom: 1px solid #f1f5f9;
            }
            .mesh-title {
                display: flex;
                align-items: center;
                gap: 7px;
                font-weight: 600;
                font-size: 13.5px;
                color: #0f172a;
            }
            .mesh-icon-btn {
                background: none;
                border: none;
                font-size: 13px;
                cursor: pointer;
                color: #94a3b8;
                padding: 4px 6px;
                border-radius: 6px;
                transition: 0.15s;
            }
            .mesh-icon-btn:hover { background: #e2e8f0; color: #334155; }
            .mesh-body { padding: 14px 16px; }
            .mesh-segmented {
                display: flex;
                background: #f1f5f9;
                padding: 3px;
                border-radius: 10px;
                margin-bottom: 12px;
            }
            .mesh-seg-tab {
                flex: 1;
                padding: 6px 4px;
                font-size: 11.5px;
                font-weight: 500;
                color: #64748b;
                border: none;
                background: transparent;
                border-radius: 7px;
                cursor: pointer;
                transition: all 0.2s;
                text-align: center;
            }
            .mesh-seg-tab.active {
                background: #ffffff;
                color: #0f172a;
                font-weight: 600;
                box-shadow: 0 1px 3px rgba(0,0,0,0.08);
            }
            .mesh-counter-badge {
                display: flex;
                align-items: center;
                justify-content: space-between;
                background: #f8fafc;
                border: 1px solid #e2e8f0;
                border-radius: 10px;
                padding: 8px 12px;
                margin-bottom: 12px;
            }
            .mesh-counter-val {
                font-weight: 700;
                font-size: 13px;
                color: #0284c7;
            }
            .mesh-counter-sub {
                font-size: 11px;
                color: #64748b;
            }
            .mesh-preview-toggle {
                font-size: 11.5px;
                color: #475569;
                text-decoration: none;
                cursor: pointer;
                display: inline-flex;
                align-items: center;
                gap: 4px;
                margin-bottom: 10px;
                font-weight: 500;
            }
            .mesh-preview-toggle:hover { color: #0284c7; }
            .mesh-preview-list {
                max-height: 130px;
                overflow-y: auto;
                background: #f8fafc;
                border: 1px solid #e2e8f0;
                border-radius: 8px;
                padding: 8px 10px;
                margin-bottom: 12px;
                font-size: 11px;
            }
            .mesh-preview-item {
                padding: 4px 0;
                border-bottom: 1px dashed #e2e8f0;
                display: flex;
                justify-content: space-between;
            }
            .mesh-preview-item:last-child { border-bottom: none; }
            .mesh-primary-btn {
                width: 100%;
                background: linear-gradient(180deg, #2563eb 0%, #1d4ed8 100%);
                color: white;
                border: none;
                border-radius: 10px;
                padding: 10px 14px;
                font-weight: 600;
                font-size: 13px;
                cursor: pointer;
                box-shadow: 0 2px 6px rgba(37, 99, 235, 0.25);
                transition: all 0.2s;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
            }
            .mesh-primary-btn:hover:not(:disabled) {
                background: linear-gradient(180deg, #1d4ed8 0%, #1e40af 100%);
                transform: translateY(-1px);
            }
            .mesh-primary-btn:disabled {
                opacity: 0.55;
                cursor: not-allowed;
                box-shadow: none;
            }
            .mesh-secondary-row {
                display: flex;
                gap: 6px;
                margin-top: 8px;
            }
            .mesh-sec-btn {
                flex: 1;
                background: #ffffff;
                border: 1px solid #e2e8f0;
                border-radius: 8px;
                padding: 6px 8px;
                font-size: 11px;
                color: #475569;
                font-weight: 500;
                cursor: pointer;
                transition: 0.15s;
                text-align: center;
            }
            .mesh-sec-btn:hover { background: #f8fafc; color: #1e293b; border-color: #cbd5e1; }
            .mesh-progress-bar {
                height: 5px;
                background: #e2e8f0;
                border-radius: 3px;
                overflow: hidden;
                margin-top: 8px;
            }
            .mesh-progress-fill {
                height: 100%;
                background: #2563eb;
                width: 0%;
                transition: width 0.2s;
            }
            .mesh-success-box {
                text-align: center;
                padding: 10px 4px;
            }
            .mesh-success-icon { font-size: 32px; margin-bottom: 6px; }
            .mesh-success-title { font-size: 15px; font-weight: 700; color: #0f172a; margin-bottom: 4px; }
            .mesh-success-desc { font-size: 12px; color: #64748b; margin-bottom: 14px; line-height: 1.4; }
            .mesh-calendar-link {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                width: 100%;
                background: #10b981;
                color: white;
                text-decoration: none;
                padding: 10px;
                border-radius: 10px;
                font-weight: 600;
                font-size: 13px;
                box-shadow: 0 2px 6px rgba(16, 185, 129, 0.25);
                margin-bottom: 8px;
                cursor: pointer;
            }
            .mesh-calendar-link:hover { background: #059669; }
            .mesh-settings-box {
                background: #f8fafc;
                border-radius: 10px;
                border: 1px solid #e2e8f0;
                padding: 12px;
                margin-bottom: 12px;
            }
            .mesh-settings-label {
                font-size: 11.5px;
                font-weight: 600;
                color: #334155;
                margin-bottom: 5px;
                display: block;
            }
            .mesh-input {
                width: 100%;
                padding: 7px 10px;
                border-radius: 6px;
                border: 1px solid #cbd5e1;
                font-size: 11px;
                margin-bottom: 8px;
            }
            .mesh-settings-hint {
                font-size: 10px;
                color: #64748b;
                line-height: 1.35;
                margin-bottom: 8px;
            }
        `;
        document.head.appendChild(style);
    }

    function createUi() {
        if (document.getElementById('mesh-cal-card') || !document.body) return;
        injectStyles();

        widgetEl = document.createElement('div');
        widgetEl.id = 'mesh-cal-card';
        renderCard();
        document.body.appendChild(widgetEl);

        setInterval(scanPageText, 1500);
        scanPageText();
    }

    function renderCard() {
        if (!widgetEl) return;
        const count = collectedLessons.length;
        const daysCount = new Set(collectedLessons.map(l => l.date)).size;

        widgetEl.innerHTML = `
            <div class="mesh-header">
                <div class="mesh-title">
                    <span>📅</span>
                    <span>МЭШ в Календарь</span>
                </div>
                <div>
                    <button class="mesh-icon-btn" id="mesh-btn-settings" title="Настройки Google Client ID">⚙️</button>
                    <button class="mesh-icon-btn" id="mesh-btn-min" title="Свернуть">_</button>
                    <button class="mesh-icon-btn" id="mesh-btn-close" title="Закрыть">✕</button>
                </div>
            </div>

            <div class="mesh-body" id="mesh-main-view">
                ${isSettingsOpen ? `
                    <!-- Окно настроек -->
                    <div class="mesh-settings-box">
                        <label class="mesh-settings-label">⚙️ Настройки Google API</label>
                        <div class="mesh-settings-hint">
                            Укажите ваш <b>Google Client ID</b> для прямой синхронизации с вашим Google Календарём.
                        </div>
                        <input type="text" class="mesh-input" id="mesh-input-client-id" placeholder="xxxx.apps.googleusercontent.com" value="${getClientId()}">
                        <div style="display:flex; gap:6px;">
                            <button class="mesh-sec-btn" id="mesh-btn-save-settings" style="background:#2563eb; color:white; border-color:#2563eb; font-weight:600;">Сохранить</button>
                            <button class="mesh-sec-btn" id="mesh-btn-cancel-settings">Назад</button>
                        </div>
                    </div>
                ` : `
                    <!-- Селектор формата -->
                    <div class="mesh-segmented">
                        <button class="mesh-seg-tab ${syncMode === 'day' ? 'active' : ''}" id="mesh-tab-day">
                            ☀️ Учебный день
                        </button>
                        <button class="mesh-seg-tab ${syncMode === 'lessons' ? 'active' : ''}" id="mesh-tab-lessons">
                            ⏰ По парам
                        </button>
                    </div>

                    <!-- Счетчик найденного -->
                    <div class="mesh-counter-badge">
                        <div>
                            <div class="mesh-counter-val">
                                ${count > 0 ? `✅ Собрано: ${count} пар` : '⏳ Ожидание расписания'}
                            </div>
                            <div class="mesh-counter-sub">
                                ${count > 0 ? `Дней в списке: ${daysCount}` : 'Переключайте дни в дневнике'}
                            </div>
                        </div>
                    </div>

                    <!-- Предпросмотр списка -->
                    ${count > 0 ? `
                        <div class="mesh-preview-toggle" id="mesh-toggle-preview">
                            ${isPreviewOpen ? '▲ Скрыть список пар' : `📋 Показать список (${count}) ▼`}
                        </div>
                        ${isPreviewOpen ? `
                            <div class="mesh-preview-list">
                                ${collectedLessons.map((l, i) => `
                                    <div class="mesh-preview-item">
                                        <span style="font-weight:600;">${l.beginTime}–${l.endTime} ${l.subject}</span>
                                        <span style="color:#64748b;">${l.room || ''}</span>
                                    </div>
                                `).join('')}
                            </div>
                        ` : ''}
                    ` : ''}

                    <!-- Главная кнопка синхронизации -->
                    <button class="mesh-primary-btn" id="mesh-btn-sync" ${count === 0 ? 'disabled' : ''}>
                        <span>🚀</span>
                        <span>${syncMode === 'day' ? `Отправить в Google (${daysCount} дн.)` : `Отправить в Google (${count} пар)`}</span>
                    </button>

                    <!-- Статус / Прогресс -->
                    <div id="mesh-sync-status" style="display:none; margin-top:10px;">
                        <div id="mesh-sync-text" style="font-size:11.5px; color:#475569; margin-bottom:4px;"></div>
                        <div class="mesh-progress-bar">
                            <div class="mesh-progress-fill" id="mesh-progress-fill"></div>
                        </div>
                    </div>

                    <!-- Вторичные действия: Скачать .ics, Обновить, Очистить -->
                    <div class="mesh-secondary-row">
                        <button class="mesh-sec-btn" id="mesh-btn-download-ics" ${count === 0 ? 'disabled' : ''} title="Скачать файл .ics без использования Google API">
                            📥 Скачать .ics
                        </button>
                        <button class="mesh-sec-btn" id="mesh-btn-scan">🔍 С экрана</button>
                        <button class="mesh-sec-btn" id="mesh-btn-clear" style="color:#94a3b8;">Сброс</button>
                    </div>
                `}
            </div>
        `;

        // Слушатели событий
        widgetEl.querySelector('#mesh-btn-close').onclick = () => widgetEl.style.display = 'none';
        widgetEl.querySelector('#mesh-btn-min').onclick = toggleMinimize;
        widgetEl.querySelector('#mesh-btn-settings').onclick = () => {
            isSettingsOpen = !isSettingsOpen;
            renderCard();
        };

        if (isSettingsOpen) {
            widgetEl.querySelector('#mesh-btn-save-settings').onclick = () => {
                const input = widgetEl.querySelector('#mesh-input-client-id');
                if (input) setClientId(input.value);
                isSettingsOpen = false;
                renderCard();
            };
            widgetEl.querySelector('#mesh-btn-cancel-settings').onclick = () => {
                isSettingsOpen = false;
                renderCard();
            };
            return;
        }

        widgetEl.querySelector('#mesh-tab-day').onclick = () => setMode('day');
        widgetEl.querySelector('#mesh-tab-lessons').onclick = () => setMode('lessons');

        const previewBtn = widgetEl.querySelector('#mesh-toggle-preview');
        if (previewBtn) {
            previewBtn.onclick = () => {
                isPreviewOpen = !isPreviewOpen;
                renderCard();
            };
        }

        widgetEl.querySelector('#mesh-btn-sync').onclick = requestGoogleAuth;
        widgetEl.querySelector('#mesh-btn-download-ics').onclick = downloadIcsFile;
        widgetEl.querySelector('#mesh-btn-scan').onclick = () => {
            scanPageText();
            updateUi();
        };
        widgetEl.querySelector('#mesh-btn-clear').onclick = () => {
            collectedLessons = [];
            updateUi();
        };
    }

    function setMode(mode) {
        syncMode = mode;
        localStorage.setItem('mesh_cal_sync_mode', mode);
        renderCard();
    }

    function toggleMinimize() {
        isMinimized = !isMinimized;
        if (isMinimized) {
            widgetEl.style.width = '150px';
            widgetEl.innerHTML = `
                <div style="padding:10px 14px; display:flex; align-items:center; justify-content:space-between; cursor:pointer;" id="mesh-min-bar">
                    <span style="font-weight:600; font-size:13px; color:#0f172a;">📅 МЭШ (${collectedLessons.length})</span>
                    <span style="font-size:12px; color:#94a3b8;">▲</span>
                </div>
            `;
            widgetEl.querySelector('#mesh-min-bar').onclick = toggleMinimize;
        } else {
            widgetEl.style.width = '310px';
            renderCard();
        }
    }

    function updateUi() {
        if (!isMinimized) renderCard();
    }

    function setSyncingState(active, text = '', percent = 0) {
        const btn = document.getElementById('mesh-btn-sync');
        const box = document.getElementById('mesh-sync-status');
        const label = document.getElementById('mesh-sync-text');
        const fill = document.getElementById('mesh-progress-fill');

        if (!btn || !box) return;

        if (active) {
            btn.disabled = true;
            btn.style.opacity = '0.6';
            box.style.display = 'block';
            if (label) label.innerText = text;
            if (fill) fill.style.width = `${percent}%`;
        } else {
            btn.disabled = false;
            btn.style.opacity = '1';
            box.style.display = 'none';
        }
    }

    function setSyncSuccess(countAdded) {
        const body = document.getElementById('mesh-main-view');
        if (!body) return;

        const unit = syncMode === 'day' ? 'учебных дней' : 'пар';
        body.innerHTML = `
            <div class="mesh-success-box">
                <div class="mesh-success-icon">🎉</div>
                <div class="mesh-success-title">Успешно перенесено!</div>
                <div class="mesh-success-desc">
                    Добавлено <b>${countAdded} ${unit}</b> в календарь <b>«Школа (МЭШ)»</b>.
                </div>
                
                <a class="mesh-calendar-link" href="https://calendar.google.com" target="_blank">
                    <span>📅</span>
                    <span>Открыть Google Календарь ↗</span>
                </a>

                <button class="mesh-sec-btn" id="mesh-btn-more" style="width:100%; padding:8px; margin-top:4px;">
                    ➕ Добавить ещё дни
                </button>
            </div>
        `;

        body.querySelector('#mesh-btn-more').onclick = () => {
            renderCard();
        };
    }

    function showError(msg) {
        alert(msg);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createUi);
    } else {
        createUi();
    }
})();

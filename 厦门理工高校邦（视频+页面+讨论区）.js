// ==UserScript==
// @name         高校邦全自动刷课+讨论（增强轮询版）
// @namespace    https://github.com/yourname/gaoxiaobang
// @version      2.2.0
// @description  跳转后主动轮询检测讨论区，超时提示，完成醒目提示
// @match        https://xmut.class.gaoxiaobang.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    const $ = unsafeWindow.$ || window.$;
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const STATE_KEY = 'gb_auto_step';

    const isChapterPage = !!(unsafeWindow.classinfo?.classId && (unsafeWindow.unitList || unsafeWindow.chapterList));
    const isDiscussPage = () => !!document.querySelector('a[content_type="Topic"]');

    // 全局标记，防止重复执行讨论
    let discussRunning = false;

    // ========== 第一部分：刷进度 ==========
    async function runProgress() {
        console.log('%c📚 第一步：开始刷视频/页面进度（极速并发）', 'color:#1fb6ff;font-size:16px');
        const urlPrefix = location.protocol + '//' + location.host;
        const classId = unsafeWindow.classinfo.classId;

        function extractAllChapters(source) {
            let result = [];
            if (!source) return result;
            if (Array.isArray(source)) {
                source.forEach(item => {
                    if (item.contentType) result.push(item);
                    if (item.itemList) result = result.concat(extractAllChapters(item.itemList));
                    if (item.chapterList) result = result.concat(extractAllChapters(item.chapterList));
                });
            } else if (typeof source === 'object') {
                if (source.contentType) result.push(source);
                if (source.itemList) result = result.concat(extractAllChapters(source.itemList));
                if (source.chapterList) result = result.concat(extractAllChapters(source.chapterList));
            }
            return result;
        }

        const dataSource = unsafeWindow.unitList || unsafeWindow.chapterList || unsafeWindow.courseData || unsafeWindow.chapters || unsafeWindow.data;
        if (!dataSource) {
            console.error('❌ 未找到章节数据源，请手动展开目录后刷新页面');
            return;
        }

        const allChapters = extractAllChapters(dataSource);
        const videoChapters = allChapters.filter(c => c.contentType === 'Video');
        const pageChapters = allChapters.filter(c => ['Page', 'UEditor', 'Html'].includes(c.contentType));

        console.log(`📹 视频章节: ${videoChapters.length} 个`);
        console.log(`📄 页面章节: ${pageChapters.length} 个`);

        // 视频并发
        const videoPromises = videoChapters.map(chapter => new Promise(resolve => {
            $.ajax({
                url: `${urlPrefix}/class/${classId}/chapter/${chapter.chapterId}/api`,
                type: 'GET',
                success: result => {
                    const seconds = (result.chapter?.video?.seconds) || 0;
                    $.ajax({
                        url: `${urlPrefix}/log/video/${chapter.chapterId}/${classId}/api`,
                        type: 'POST',
                        data: { data: JSON.stringify([{ state: "listening", level: 2, ch: seconds, mh: 0 }]) },
                        success: () => { console.log(`✅ 视频 ${chapter.chapterId} 上报成功`); resolve(); },
                        error: xhr => { console.error(`❌ 视频 ${chapter.chapterId} 上报失败 (${xhr.status})`); resolve(); }
                    });
                },
                error: xhr => { console.error(`❌ 视频 ${chapter.chapterId} 内容获取失败 (${xhr.status})`); resolve(); }
            });
        }));

        // 页面并发
        pageChapters.forEach((chapter, index) => {
            $.ajax({
                url: `${urlPrefix}/class/${classId}/chapter/${chapter.chapterId}/api?${Date.now()}`,
                type: 'GET',
                success: () => console.log(`🟢 页面 ${chapter.chapterId} GET成功 (${index+1}/${pageChapters.length})`),
                error: xhr => console.warn(`🔴 页面 ${chapter.chapterId} GET失败 (${xhr.status})，但可能仍有效`)
            });
        });

        await Promise.all(videoPromises);
        console.log(`📄 页面章节 ${pageChapters.length} 个GET请求已全部发出（并发）`);
        console.log('%c✅ 进度刷取完成，立即跳转讨论区', 'color:green;font-size:14px');
        GM_setValue(STATE_KEY, 'discuss');

        // 开始主动轮询检测讨论区
        startPollingForDiscuss();

        // 跳转
        const firstTopic = document.querySelector('a[content_type="Topic"]');
        if (firstTopic) {
            const chapterId = firstTopic.getAttribute('chapter_id');
            if (chapterId) {
                location.hash = location.hash.replace(/chapterId=\d+/, `chapterId=${chapterId}`);
                console.log(`🚀 已通过 hash 跳转到专题讨论 (chapterId=${chapterId})`);
            } else {
                firstTopic.click();
                console.log('🚀 已通过点击跳转到专题讨论');
            }
        } else {
            console.warn('未找到专题讨论入口，请手动点击进入');
        }
    }

    // ========== 主动轮询检测讨论区 ==========
    let pollingTimer = null;
    let pollStartTime = null;
    const POLL_TIMEOUT = 15000; // 15秒超时

    function startPollingForDiscuss() {
        if (pollingTimer) clearInterval(pollingTimer);
        pollStartTime = Date.now();

        pollingTimer = setInterval(async () => {
            const step = GM_getValue(STATE_KEY, 'progress');
            if (step !== 'discuss') {
                clearInterval(pollingTimer);
                return;
            }

            // 检测到讨论区元素且未在执行
            if (isDiscussPage() && !discussRunning) {
                clearInterval(pollingTimer);
                console.log('%c🔔 检测到讨论区已加载，继续执行第二步...', 'color:#1fb6ff;font-size:14px');
                await runDiscuss();
                return;
            }

            // 超时提示
            if (Date.now() - pollStartTime > POLL_TIMEOUT) {
                clearInterval(pollingTimer);
                console.warn('%c⚠️ 等待讨论区加载超时！请手动在控制台输入 autoContinue() 继续，或刷新页面。', 'color:orange;font-size:14px');
                window.autoContinue = async () => {
                    if (isDiscussPage() && !discussRunning) {
                        await runDiscuss();
                    } else {
                        console.error('当前页面不是讨论区或已在执行中');
                    }
                };
                console.log('%c👉 手动继续命令已挂载：autoContinue()', 'color:yellow');
            }
        }, 800);
    }

    // ========== 第二部分：讨论区批量评论 ==========
    async function runDiscuss() {
        if (discussRunning) return;
        discussRunning = true;

        console.log('%c💬 第二步：开始批量评论', 'color:#1fb6ff;font-size:16px');

        const Editor = {
            getUEditor() {
                const UE = unsafeWindow.UE || window.UE;
                if (!UE?.instants) return null;
                return Object.values(UE.instants).find(i => i?.setContent);
            },
            setContent(content) {
                const ue = this.getUEditor();
                if (ue) {
                    ue.setContent(content);
                    try { ue.fireEvent('contentChange'); } catch(e) {}
                    return true;
                }
                const iframe = document.querySelector('iframe[id^="ueditor_"]');
                if (iframe) {
                    try {
                        const doc = iframe.contentDocument || iframe.contentWindow.document;
                        const body = doc.querySelector('body[contenteditable="true"]');
                        if (body) {
                            body.innerHTML = `<p>${content.replace(/\n/g, '</p><p>')}</p>`;
                            body.dispatchEvent(new Event('input', { bubbles: true }));
                            return true;
                        }
                    } catch(e) {}
                }
                return false;
            },
            getLongestComment() {
                const texts = [];
                document.querySelectorAll('.reply-content').forEach(el => {
                    const p = el.querySelector('p');
                    const text = (p ? p.innerText : el.innerText).trim();
                    if (text) texts.push(text);
                });
                if (!texts.length) {
                    document.querySelectorAll('.reply-content-container').forEach(el => {
                        const text = el.innerText.replace(/.*回复/g, '').trim();
                        if (text) texts.push(text);
                    });
                }
                return texts.length ? texts.reduce((a,b) => a.length>b.length?a:b) : '';
            },
            findReplyBtn() {
                const replyBtn = document.querySelector('i.post-submit');
                if (replyBtn && replyBtn.innerText.trim() === '回复') return replyBtn;
                return Array.from(document.querySelectorAll('i, button, .btn')).find(el => {
                    const text = el.innerText.trim();
                    return text === '回复' || (text.includes('回复') && !text.includes('编辑'));
                });
            },
            enableButton(btn) {
                if (!btn) return;
                btn.classList.remove('disabled', 'btn-disabled', 'ban-click');
                btn.style.pointerEvents = 'auto';
                btn.style.opacity = '1';
            },
            async waitForSuccess() {
                const start = Date.now();
                while (Date.now() - start < 8000) {
                    const tip = document.querySelector('.success-tip, .success, .message-success, .ant-message-success');
                    if (tip && tip.offsetParent !== null) return true;
                    const btn = document.querySelector('i.post-submit-edit, i.post-submit');
                    if (btn && btn.innerText.trim() === '编辑') return true;
                    await wait(1000);
                }
                return false;
            }
        };

        const getTopicChapters = () => {
            return Array.from(document.querySelectorAll('a[content_type="Topic"]')).map(a => ({
                chapterId: a.getAttribute('chapter_id'),
                title: a.querySelector('.title')?.innerText?.trim() || a.innerText.trim()
            }));
        };

        const switchToChapter = chapterId => {
            location.hash = location.hash.replace(/chapterId=\d+/, `chapterId=${chapterId}`);
        };

        const topics = getTopicChapters();
        if (!topics.length) {
            console.error('❌ 未找到任何专题，请检查页面');
            discussRunning = false;
            return;
        }
        console.log(`🎯 发现 ${topics.length} 个专题`);

        for (let i = 0; i < topics.length; i++) {
            const t = topics[i];
            console.log(`\n📌 [${i+1}/${topics.length}] 处理专题: ${t.title}`);
            switchToChapter(t.chapterId);
            await wait(4000);

            const editBtn = document.querySelector('i.post-submit-edit');
            if (editBtn && editBtn.innerText.trim() === '编辑') {
                console.warn('  ⏭️ 该专题已提交过（检测到“编辑”按钮），跳过');
                continue;
            }

            const comment = Editor.getLongestComment();
            if (!comment) {
                console.warn('  ⚠️ 未找到可复制评论，跳过');
                continue;
            }
            console.log(`  📋 复制评论 (${comment.length}字)`);

            if (!Editor.setContent(comment)) {
                console.error('  ❌ 填充内容失败');
                continue;
            }
            console.log('  ✅ 内容已填入');
            await wait(1000);

            const btn = Editor.findReplyBtn();
            if (!btn) {
                console.warn('  ❌ 未找到“回复”按钮，跳过');
                continue;
            }
            Editor.enableButton(btn);
            console.log(`  🚀 点击提交`);
            btn.click();

            await Editor.waitForSuccess();
            await wait(2000);
        }

        console.log('%c🎉🎉🎉 所有专题评论完成！刷新页面即可查看结果。 🎉🎉🎉', 'color:green;font-size:20px;background:#f0f0f0;padding:8px;border-radius:4px');
        GM_deleteValue(STATE_KEY);
        discussRunning = false;
    }

    // ========== 主控逻辑 ==========
    (async function main() {
        const step = GM_getValue(STATE_KEY, 'progress');

        console.log(`🔍 状态: ${step} | 课程页: ${isChapterPage} | 讨论页: ${isDiscussPage()}`);

        // 优先课程页刷进度
        if (isChapterPage) {
            if (step === 'discuss') {
                console.log('重置状态为进度模式');
                GM_setValue(STATE_KEY, 'progress');
            }
            await runProgress();
            return;
        }

        // 讨论页且状态为 discuss → 直接评论（也可能需要轮询）
        if (isDiscussPage() && step === 'discuss') {
            if (!discussRunning) {
                await runDiscuss();
            }
            return;
        }

        // 讨论页但状态为 progress → 直接评论
        if (isDiscussPage() && step === 'progress') {
            console.log('已在讨论页，直接执行评论');
            GM_setValue(STATE_KEY, 'discuss');
            if (!discussRunning) {
                await runDiscuss();
            }
            return;
        }

        // 其他情况：如果状态是 discuss，启动轮询等待进入讨论区
        if (step === 'discuss') {
            startPollingForDiscuss();
            console.log('⏳ 等待进入讨论区...（将自动检测）');
        } else {
            console.log('当前页面无需自动操作');
        }
    })();

})();
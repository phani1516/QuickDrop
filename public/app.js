/* ====================================================
   QuickDrop — P2P Client Logic
   ====================================================
   WebRTC data channels for file/text transfer.
   WebSocket signaling for presence + negotiation.
   No server-side file storage.
   ==================================================== */

(function () {
    'use strict';

    // ---- Constants ----
    const CHUNK_SIZE = 64 * 1024;                // 64 KB per chunk
    const BUFFER_THRESHOLD = 16 * 1024 * 1024;   // 16 MB backpressure limit
    const HEARTBEAT_MS = 12000;
    const ICE_SERVERS = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ];

    // ---- State ----
    let ws = null;
    let mySessionId = null;
    let myCodename = null;
    let devices = [];
    let selectedDeviceId = null;
    let heartbeatTimer = null;
    const peers = new Map();              // sessionId → { pc, dc, dcReady (Promise) }
    const pendingOffers = new Map();      // transferId → { targetId, files }
    const receiveBuffers = new Map();     // peerId → { transferId, files Map, currentIdx, … }
    const pendingIncoming = new Map();    // transferId → { senderId, senderName, files }

    // ---- Device Detection (from user-agent) ----
    function detectDevice() {
        const ua = navigator.userAgent;
        let deviceType = 'desktop';
        let platform = 'other';

        if (/tablet|ipad/i.test(ua)) deviceType = 'tablet';
        else if (/mobile|iphone|android.*mobile/i.test(ua)) deviceType = 'mobile';

        if (/windows/i.test(ua)) platform = 'windows';
        else if (/macintosh|mac os/i.test(ua)) platform = 'macos';
        else if (/linux/i.test(ua)) platform = 'linux';
        else if (/android/i.test(ua)) platform = 'android';
        else if (/iphone|ipad|ipod/i.test(ua)) platform = 'ios';

        return { deviceType, platform };
    }

    // ---- SVG Icons ----
    const ICONS = {
        mobile: '<svg viewBox="0 0 24 24"><path d="M17 1.01L7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z"/></svg>',
        tablet: '<svg viewBox="0 0 24 24"><path d="M18.5 0h-14A2.5 2.5 0 002 2.5v19A2.5 2.5 0 004.5 24h14a2.5 2.5 0 002.5-2.5v-19A2.5 2.5 0 0018.5 0zm-7 23c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm7.5-4H4V3h15v16z"/></svg>',
        desktop: '<svg viewBox="0 0 24 24"><path d="M21 2H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7l-2 3v1h8v-1l-2-3h7c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 12H3V4h18v10z"/></svg>',
    };

    // ================================================================
    //   SIGNALING CLIENT (WebSocket)
    // ================================================================

    function connectSignaling() {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${proto}//${location.host}/ws`);

        ws.onopen = () => {
            const { deviceType, platform } = detectDevice();
            wsSend({ type: 'register', deviceType, platform });
            startHeartbeat();
        };

        ws.onmessage = (event) => {
            let msg;
            try { msg = JSON.parse(event.data); } catch { return; }
            handleServerMessage(msg);
        };

        ws.onclose = () => {
            stopHeartbeat();
            // Reconnect after 2s
            setTimeout(connectSignaling, 2000);
        };

        ws.onerror = () => { /* onclose will fire */ };
    }

    function wsSend(data) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
    }

    function startHeartbeat() {
        stopHeartbeat();
        heartbeatTimer = setInterval(() => wsSend({ type: 'ping' }), HEARTBEAT_MS);
    }
    function stopHeartbeat() {
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    }

    // ---- Server Message Router ----
    function handleServerMessage(msg) {
        switch (msg.type) {
            case 'registered':
                mySessionId = msg.sessionId;
                myCodename = msg.codename;
                el('my-device-name').textContent = myCodename;
                el('center-label').textContent = myCodename;
                requestNotificationPermission();
                break;

            case 'device-list':
                devices = msg.devices;
                renderDevices();
                break;

            case 'signal':
                handleSignal(msg.senderId, msg.signalType, msg.data);
                break;

            case 'file-offer':
                handleIncomingFileOffer(msg);
                break;

            case 'file-response':
                handleFileResponse(msg);
                break;

            case 'text-message':
                showReceivedText(msg.senderName, msg.text);
                break;

            case 'room-joined':
                el('room-label').textContent = msg.roomCode;
                el('room-btn').classList.add('active');
                el('leave-room-btn').style.display = '';
                closeModal('room-modal');
                toast(`Joined room: ${msg.roomCode}`, 'info');
                break;

            case 'room-left':
                el('room-label').textContent = 'Room';
                el('room-btn').classList.remove('active');
                el('leave-room-btn').style.display = 'none';
                toast('Left room', 'info');
                break;

            case 'error':
                toast(msg.message, 'error');
                break;
        }
    }

    // ================================================================
    //   WEBRTC PEER MANAGER
    // ================================================================

    function getOrCreatePeer(peerId, isInitiator) {
        if (peers.has(peerId)) {
            const peer = peers.get(peerId);
            if (peer.dc && peer.dc.readyState === 'open') {
                return { peer, ready: Promise.resolve() };
            }
            if (peer.dcReady) return { peer, ready: peer.dcReady };
        }
        return createPeer(peerId, isInitiator);
    }

    function createPeer(peerId, isInitiator) {
        // Clean up any existing connection
        destroyPeer(peerId);

        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        let dcReadyResolve;
        const dcReady = new Promise(r => { dcReadyResolve = r; });
        const peer = { pc, dc: null, dcReady, dcReadyResolve };

        // ICE candidates → relay via signaling
        pc.onicecandidate = (e) => {
            if (e.candidate) {
                wsSend({ type: 'signal', targetId: peerId, signalType: 'ice-candidate', data: e.candidate });
            }
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                destroyPeer(peerId);
            }
        };

        // If initiator, create the data channel
        if (isInitiator) {
            const dc = pc.createDataChannel('quickdrop', { ordered: true });
            setupDataChannel(peer, dc, peerId);
            // Create and send offer
            pc.createOffer().then(offer => {
                pc.setLocalDescription(offer);
                wsSend({ type: 'signal', targetId: peerId, signalType: 'offer', data: offer });
            });
        }

        // If answerer, receive data channel
        pc.ondatachannel = (event) => {
            setupDataChannel(peer, event.channel, peerId);
        };

        peers.set(peerId, peer);
        return { peer, ready: dcReady };
    }

    function setupDataChannel(peer, dc, peerId) {
        peer.dc = dc;
        dc.binaryType = 'arraybuffer';
        dc.onopen = () => {
            if (peer.dcReadyResolve) peer.dcReadyResolve();
        };
        dc.onmessage = (e) => handleDCMessage(peerId, e);
        dc.onclose = () => { /* connection may be re-established later */ };
        dc.onerror = () => { /* fail transfers */ };
    }

    function destroyPeer(peerId) {
        const peer = peers.get(peerId);
        if (!peer) return;
        if (peer.dc) try { peer.dc.close(); } catch {}
        if (peer.pc) try { peer.pc.close(); } catch {}
        peers.delete(peerId);
    }

    // ---- Handle incoming WebRTC signals ----
    function handleSignal(senderId, signalType, data) {
        if (signalType === 'offer') {
            const { peer } = createPeer(senderId, false);
            peer.pc.setRemoteDescription(new RTCSessionDescription(data)).then(() => {
                return peer.pc.createAnswer();
            }).then(answer => {
                peer.pc.setLocalDescription(answer);
                wsSend({ type: 'signal', targetId: senderId, signalType: 'answer', data: answer });
            }).catch(err => console.error('Signal offer error:', err));

        } else if (signalType === 'answer') {
            const peer = peers.get(senderId);
            if (peer) {
                peer.pc.setRemoteDescription(new RTCSessionDescription(data))
                    .catch(err => console.error('Signal answer error:', err));
            }

        } else if (signalType === 'ice-candidate') {
            const peer = peers.get(senderId);
            if (peer) {
                peer.pc.addIceCandidate(new RTCIceCandidate(data))
                    .catch(() => { /* non-fatal */ });
            }
        }
    }

    // ================================================================
    //   DATA CHANNEL MESSAGE HANDLER (receiver side)
    // ================================================================

    function handleDCMessage(peerId, event) {
        if (typeof event.data === 'string') {
            const msg = JSON.parse(event.data);
            switch (msg.type) {
                case 'transfer-start': {
                    receiveBuffers.set(peerId, {
                        transferId: msg.transferId,
                        totalFiles: msg.totalFiles,
                        files: new Map(),
                        currentIdx: -1,
                        receivedBytes: 0,
                        totalBytes: 0,
                        completedFiles: 0,
                    });
                    break;
                }
                case 'file-start': {
                    const buf = receiveBuffers.get(peerId);
                    if (!buf) break;
                    buf.currentIdx = msg.fileIndex;
                    buf.files.set(msg.fileIndex, {
                        fileName: msg.fileName,
                        fileSize: msg.fileSize,
                        fileType: msg.fileType,
                        totalChunks: msg.totalChunks,
                        chunks: [],
                        received: 0,
                    });
                    buf.totalBytes += msg.fileSize;
                    break;
                }
                case 'file-end': {
                    const buf = receiveBuffers.get(peerId);
                    if (!buf) break;
                    const fi = buf.files.get(msg.fileIndex);
                    if (fi) {
                        const blob = new Blob(fi.chunks, { type: fi.fileType || 'application/octet-stream' });
                        triggerDownload(blob, fi.fileName);
                        addActivityItem(fi.fileName, fi.fileSize, 'received');
                        buf.completedFiles++;
                    }
                    break;
                }
                case 'transfer-end': {
                    const buf = receiveBuffers.get(peerId);
                    const n = buf ? buf.completedFiles : 0;
                    receiveBuffers.delete(peerId);
                    toast(`Received ${n} file${n !== 1 ? 's' : ''} successfully!`, 'success');
                    systemNotify('Transfer Complete', `Received ${n} file${n !== 1 ? 's' : ''}.`);
                    break;
                }
                case 'text': {
                    const device = devices.find(d => d.sessionId === peerId);
                    const name = device ? device.codename : 'Unknown';
                    showReceivedText(name, msg.text);
                    break;
                }
            }
        } else {
            // Binary → file chunk
            const buf = receiveBuffers.get(peerId);
            if (!buf) return;
            const fi = buf.files.get(buf.currentIdx);
            if (!fi) return;
            fi.chunks.push(event.data);
            fi.received += event.data.byteLength;
            buf.receivedBytes += event.data.byteLength;

            // Update progress
            const pct = buf.totalBytes > 0 ? Math.round((buf.receivedBytes / buf.totalBytes) * 100) : 0;
            updateReceiveProgress(pct);
        }
    }

    // ================================================================
    //   FILE TRANSFER — SENDER
    // ================================================================

    async function initiateFileTransfer(targetId, files) {
        const transferId = crypto.randomUUID ? crypto.randomUUID() : randomId();
        const fileMeta = Array.from(files).map(f => ({ name: f.name, size: f.size, type: f.type }));

        // Send offer via signaling
        wsSend({
            type: 'file-offer',
            targetId,
            transferId,
            files: fileMeta,
        });

        // Store pending offer
        pendingOffers.set(transferId, { targetId, files: Array.from(files) });

        showSendProgress(0, 'Waiting for acceptance…');
        toast('File offer sent. Waiting for recipient…', 'info');
    }

    function handleFileResponse(msg) {
        const offer = pendingOffers.get(msg.transferId);
        if (!offer) return;
        pendingOffers.delete(msg.transferId);

        if (!msg.accepted) {
            showSendProgress(0, 'Transfer declined.');
            toast('Recipient declined the transfer.', 'error');
            hideSendProgressAfterDelay();
            return;
        }

        toast('Transfer accepted! Sending…', 'success');
        sendFilesOverDC(offer.targetId, offer.files, msg.transferId);
    }

    async function sendFilesOverDC(targetId, files, transferId) {
        try {
            const { peer, ready } = getOrCreatePeer(targetId, true);

            // Wait for data channel with timeout
            const timeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Connection timed out')), 15000)
            );
            await Promise.race([ready, timeout]);

            const dc = peer.dc;
            if (!dc || dc.readyState !== 'open') throw new Error('Data channel not open');

            dc.send(JSON.stringify({ type: 'transfer-start', transferId, totalFiles: files.length }));

            let totalBytes = 0;
            let sentBytes = 0;
            for (const f of files) totalBytes += f.size;

            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const totalChunks = Math.ceil(file.size / CHUNK_SIZE) || 1;

                dc.send(JSON.stringify({
                    type: 'file-start', transferId, fileIndex: i,
                    fileName: file.name, fileSize: file.size,
                    fileType: file.type || 'application/octet-stream',
                    totalChunks,
                }));

                for (let c = 0; c < totalChunks; c++) {
                    const start = c * CHUNK_SIZE;
                    const end = Math.min(start + CHUNK_SIZE, file.size);
                    const chunk = file.slice(start, end);
                    const buffer = await chunk.arrayBuffer();

                    // Backpressure
                    while (dc.bufferedAmount > BUFFER_THRESHOLD) {
                        await new Promise(resolve => {
                            dc.bufferedAmountLowThreshold = BUFFER_THRESHOLD / 4;
                            dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; resolve(); };
                        });
                    }

                    dc.send(buffer);
                    sentBytes += buffer.byteLength;
                    showSendProgress(Math.round((sentBytes / totalBytes) * 100));
                }

                dc.send(JSON.stringify({ type: 'file-end', transferId, fileIndex: i }));
                addActivityItem(file.name, file.size, 'sent');
            }

            dc.send(JSON.stringify({ type: 'transfer-end', transferId }));
            showSendProgress(100, `✓ Sent ${files.length} file${files.length > 1 ? 's' : ''}`);
            toast('Transfer complete!', 'success');
            hideSendProgressAfterDelay();

        } catch (err) {
            console.error('Send failed:', err);
            showSendProgress(0, `Error: ${err.message}`);
            toast('Transfer failed: ' + err.message, 'error');
            hideSendProgressAfterDelay(5000);
        }
    }

    // ================================================================
    //   FILE TRANSFER — INCOMING OFFER
    // ================================================================

    function handleIncomingFileOffer(msg) {
        pendingIncoming.set(msg.transferId, msg);

        const totalSize = msg.files.reduce((s, f) => s + f.size, 0);
        const detailsEl = el('transfer-details');
        detailsEl.innerHTML = `
            <div class="transfer-sender">From: ${esc(msg.senderName)}</div>
            <ul class="transfer-file-list">
                ${msg.files.map(f => `<li><span>${esc(f.name)}</span><span>${formatSize(f.size)}</span></li>`).join('')}
            </ul>
            <div style="margin-top:0.5rem;font-size:0.8rem;color:var(--text-secondary);">
                Total: ${formatSize(totalSize)} · ${msg.files.length} file${msg.files.length > 1 ? 's' : ''}
            </div>
        `;

        // Store current transferId for the modal buttons
        el('transfer-modal').dataset.transferId = msg.transferId;
        showModal('transfer-modal');
        systemNotify('Incoming Files', `${msg.senderName} wants to send ${msg.files.length} file(s).`);
    }

    // ================================================================
    //   TEXT SHARING
    // ================================================================

    async function sendTextToDevice(targetId, text) {
        if (!text.trim()) return;
        // Try data channel first
        const peer = peers.get(targetId);
        if (peer && peer.dc && peer.dc.readyState === 'open') {
            peer.dc.send(JSON.stringify({ type: 'text', text }));
        } else {
            // Fallback to signaling relay
            wsSend({ type: 'text-message', targetId, text });
        }
        toast('Text sent!', 'success');
        addActivityItem(`Text: "${text.slice(0, 50)}${text.length > 50 ? '…' : ''}"`, text.length, 'text-sent');
    }

    function showReceivedText(senderName, text) {
        el('text-sender-name').textContent = `From: ${senderName}`;
        el('text-content').textContent = text;

        // Check if text is a URL
        const isUrl = /^https?:\/\/\S+$/i.test(text.trim());
        el('open-link-btn').style.display = isUrl ? '' : 'none';
        el('open-link-btn').onclick = () => { window.open(text.trim(), '_blank'); closeModal('text-modal'); };

        showModal('text-modal');
        systemNotify('Incoming Message', `${senderName}: ${text.slice(0, 80)}`);
        addActivityItem(`Text from ${senderName}`, text.length, 'text-received');
    }

    // ================================================================
    //   UI CONTROLLER
    // ================================================================

    // ---- Device Rendering (radar) ----
    function renderDevices() {
        const container = el('devices-container');
        container.innerHTML = '';

        const count = devices.length + 1; // +1 for self
        el('online-count-text').textContent = `${count} online`;

        if (devices.length === 0) {
            el('radar-hint').textContent = 'Waiting for nearby devices…';
        } else {
            el('radar-hint').textContent = 'Click a device to share';
        }

        // If selected device went offline, deselect
        if (selectedDeviceId && !devices.find(d => d.sessionId === selectedDeviceId)) {
            deselectDevice();
        }

        const radiusPct = 40;
        const step = devices.length > 0 ? (Math.PI * 2) / devices.length : 0;

        devices.forEach((device, i) => {
            const angle = i * step - Math.PI / 2;
            const left = 50 + radiusPct * Math.cos(angle);
            const top = 50 + radiusPct * Math.sin(angle);

            const chip = document.createElement('div');
            chip.className = 'device-chip' + (device.sessionId === selectedDeviceId ? ' selected' : '');
            chip.style.left = left + '%';
            chip.style.top = top + '%';
            chip.style.animationDelay = (i * 0.08) + 's';
            chip.dataset.sessionId = device.sessionId;

            const iconKey = device.deviceType === 'tablet' ? 'tablet' : (device.deviceType === 'mobile' ? 'mobile' : 'desktop');
            chip.innerHTML = `${ICONS[iconKey]}<span class="chip-name">${esc(device.codename)}</span>`;

            chip.addEventListener('click', () => selectDevice(device));
            container.appendChild(chip);
        });
    }

    function selectDevice(device) {
        selectedDeviceId = device.sessionId;
        el('no-selection').style.display = 'none';
        el('send-panel').style.display = '';

        const iconKey = device.deviceType === 'tablet' ? 'tablet' : (device.deviceType === 'mobile' ? 'mobile' : 'desktop');
        el('selected-device-icon').innerHTML = ICONS[iconKey];
        el('selected-device-name').textContent = device.codename;

        renderDevices(); // re-render to update selected state
    }

    function deselectDevice() {
        selectedDeviceId = null;
        el('no-selection').style.display = '';
        el('send-panel').style.display = 'none';
        hideSendProgress();
        renderDevices();
    }

    // ---- Progress ----
    function showSendProgress(pct, msg) {
        el('upload-status').style.display = 'block';
        el('progress-fill').style.width = pct + '%';
        if (msg) el('progress-text').textContent = msg;
        else el('progress-text').textContent = `Sending… ${pct}%`;
    }
    function hideSendProgress() {
        el('upload-status').style.display = 'none';
        el('progress-fill').style.width = '0%';
    }
    function hideSendProgressAfterDelay(ms) {
        setTimeout(hideSendProgress, ms || 3000);
    }

    let receiveProgressToast = null;
    function updateReceiveProgress(pct) {
        // Reuse a single persistent toast for receive progress
        if (!receiveProgressToast || !receiveProgressToast.parentNode) {
            receiveProgressToast = document.createElement('div');
            receiveProgressToast.className = 'toast info';
            el('toast-container').appendChild(receiveProgressToast);
        }
        receiveProgressToast.textContent = `Receiving… ${pct}%`;
        if (pct >= 100) {
            setTimeout(() => {
                if (receiveProgressToast && receiveProgressToast.parentNode) {
                    receiveProgressToast.classList.add('toast-out');
                    setTimeout(() => receiveProgressToast.remove(), 300);
                    receiveProgressToast = null;
                }
            }, 1500);
        }
    }

    // ---- Activity Log ----
    function addActivityItem(name, size, type) {
        const list = el('files-list');
        const empty = list.querySelector('.empty-state');
        if (empty) empty.remove();

        const item = document.createElement('div');
        item.className = 'file-item';

        let badgeClass = '';
        let badgeText = '';
        if (type === 'sent') { badgeClass = 'activity-badge sent'; badgeText = 'Sent'; }
        else if (type === 'received') { badgeClass = 'download-btn'; badgeText = 'Received'; }
        else if (type === 'text-sent') { badgeClass = 'activity-badge text-badge'; badgeText = 'Sent'; }
        else if (type === 'text-received') { badgeClass = 'activity-badge text-badge'; badgeText = 'Received'; }

        item.innerHTML = `
            <div class="file-info">
                <span class="file-name" title="${esc(name)}">${esc(name)}</span>
                <span class="file-meta">${formatSize(size)} · ${new Date().toLocaleTimeString()}</span>
            </div>
            <span class="${badgeClass}">${badgeText}</span>
        `;
        list.prepend(item);
    }

    // ---- Toasts ----
    function toast(message, type) {
        const t = document.createElement('div');
        t.className = `toast ${type || 'info'}`;
        t.textContent = message;
        el('toast-container').appendChild(t);
        setTimeout(() => {
            t.classList.add('toast-out');
            setTimeout(() => t.remove(), 300);
        }, 4000);
    }

    // ---- Modals ----
    function showModal(id) { el(id).style.display = ''; }
    function closeModal(id) { el(id).style.display = 'none'; }

    // ---- System Notifications ----
    function requestNotificationPermission() {
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    }
    function systemNotify(title, body) {
        if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
            new Notification(title, { body, icon: '/manifest.json' });
        }
    }

    // ---- Download Trigger ----
    function triggerDownload(blob, fileName) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    // ---- Drag & Drop ----
    function setupDragDrop() {
        const drop = el('drop-area');
        const input = el('file-input');

        drop.addEventListener('click', () => input.click());

        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(e =>
            drop.addEventListener(e, ev => { ev.preventDefault(); ev.stopPropagation(); }, false)
        );
        ['dragenter', 'dragover'].forEach(e =>
            drop.addEventListener(e, () => drop.classList.add('dragover'), false)
        );
        ['dragleave', 'drop'].forEach(e =>
            drop.addEventListener(e, () => drop.classList.remove('dragover'), false)
        );

        drop.addEventListener('drop', (e) => {
            const files = e.dataTransfer.files;
            if (files.length && selectedDeviceId) {
                initiateFileTransfer(selectedDeviceId, files);
            } else if (!selectedDeviceId) {
                toast('Select a device first!', 'error');
            }
        });

        input.addEventListener('change', function () {
            if (this.files.length && selectedDeviceId) {
                initiateFileTransfer(selectedDeviceId, this.files);
                this.value = '';
            } else if (!selectedDeviceId) {
                toast('Select a device first!', 'error');
            }
        });
    }

    // ---- Event Wiring ----
    function wireEvents() {
        // Deselect device
        el('deselect-btn').addEventListener('click', deselectDevice);

        // Send text
        el('send-text-btn').addEventListener('click', () => {
            const text = el('text-input').value;
            if (selectedDeviceId && text.trim()) {
                sendTextToDevice(selectedDeviceId, text);
                el('text-input').value = '';
            }
        });
        el('text-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                el('send-text-btn').click();
            }
        });

        // Transfer modal — accept / reject
        el('accept-transfer-btn').addEventListener('click', () => {
            const tid = el('transfer-modal').dataset.transferId;
            const offer = pendingIncoming.get(tid);
            if (offer) {
                wsSend({ type: 'file-response', targetId: offer.senderId, transferId: tid, accepted: true });
                pendingIncoming.delete(tid);
                toast('Transfer accepted. Receiving…', 'success');
            }
            closeModal('transfer-modal');
        });
        el('reject-transfer-btn').addEventListener('click', () => {
            const tid = el('transfer-modal').dataset.transferId;
            const offer = pendingIncoming.get(tid);
            if (offer) {
                wsSend({ type: 'file-response', targetId: offer.senderId, transferId: tid, accepted: false });
                pendingIncoming.delete(tid);
            }
            closeModal('transfer-modal');
        });

        // Text modal — copy / dismiss
        el('copy-text-btn').addEventListener('click', () => {
            const text = el('text-content').textContent;
            navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard!', 'success'));
            closeModal('text-modal');
        });
        el('dismiss-text-btn').addEventListener('click', () => closeModal('text-modal'));

        // Room modal
        el('room-btn').addEventListener('click', () => showModal('room-modal'));
        el('cancel-room-btn').addEventListener('click', () => closeModal('room-modal'));
        el('join-room-btn').addEventListener('click', () => {
            const code = el('room-input').value.trim();
            if (code) wsSend({ type: 'join-room', roomCode: code });
        });
        el('leave-room-btn').addEventListener('click', () => {
            wsSend({ type: 'leave-room' });
            closeModal('room-modal');
        });
        el('room-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') el('join-room-btn').click();
        });
    }

    // ---- Helpers ----
    function el(id) { return document.getElementById(id); }
    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function formatSize(b) {
        if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
        if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
        if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
        return b + ' B';
    }
    function randomId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }

    // ================================================================
    //   PWA Registration
    // ================================================================
    function registerSW() {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js').catch(() => {});
        }
    }

    // ================================================================
    //   INIT
    // ================================================================
    function init() {
        setupDragDrop();
        wireEvents();
        connectSignaling();
        registerSW();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();

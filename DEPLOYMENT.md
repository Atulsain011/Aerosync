# 📡 AeroSync Deployment & Connection Guide

This guide details how to run, deploy, and share your **AeroSync File Server** so that everyone on your local network (LAN) or across the Internet can easily upload and share files with you.

---

## 🚀 Quick Start (One-Click Launchers)

We have provided simple, double-clickable scripts to start the server and automatically launch the dashboard in your default browser.

### 🐧 Linux & macOS
1. Open your terminal in the directory or double-click the script:
   ```bash
   ./start-aerosync.sh
   ```
2. The script will automatically check for Node.js, run `npm install` if dependencies are missing, start the server, and open `http://localhost:5000` in your web browser.

### 🪟 Windows
1. Double-click the file:
   ```cmd
   start-aerosync.bat
   ```
2. A command prompt will boot up, install dependencies, run the server, and open your browser automatically.

---

## 🐳 Docker Deployment (Recommended for Home Labs & Servers)

To run AeroSync in a isolated container environment, use the pre-configured Docker files:

1. **Start the container in the background:**
   ```bash
   docker compose up -d --build
   ```
2. **Access the interface:** Open your browser and navigate to `http://localhost:5000`.
3. **Persisted Folders:**
   - `./shared_files/` on your host will store all files uploaded to "My Shared Files".
   - `./settings.json` on your host stores your device nickname, port, speed limits, and preferences.

---

## 📶 Local Network (LAN) Connection Guide

To share files with other computers, tablets, and phones on the **same Wi-Fi or local network**:

1. **Find your local IP address:**
   - On server startup, the terminal logs show a list of LAN network interfaces (e.g. `http://192.168.1.56:5000`).
   - Or open the **System Control Panel** settings inside the web UI, where all active interface links are listed under the **Server Config** tab.
2. **Scan or Share:**
   - On the web UI desktop, click the **AeroShare** button (bottom left) and select **Share Connection**.
   - A popup will show a **QR Code** for each IP address. 
   - Simply point a smartphone camera or other laptop at the host screen, scan the QR code, and open the link!
3. **Approve Peers (OTP Security):**
   - When a peer connects, they will be prompted to enter a **6-digit OTP code**.
   - Find this OTP displayed in the **Network Peers** window (Radar Scanner) on the host computer.
   - Enter it on the client device to establish a secure authorized sharing session.

### 🔒 Firewall Issues (Linux Users)
If client devices cannot open the page and the browser times out, the local firewall on the host computer is likely blocking port `5000`. Open your terminal and run:
```bash
sudo ufw allow 5000/tcp
```

---

## 🛜 Hotspot & AP Isolation Fixes

Many mobile hotspots and public Wi-Fi networks block client-to-client traffic (called **AP Isolation** or **client isolation**). If your phone and laptop are connected to the same hotspot but cannot see each other on the Radar:

### Solution A: Enable the Hotspot Tunnel (Built-in Bypass)
1. In the Web UI, open **System Control Panel** -> **Server Config**.
2. Turn on the **Hotspot Tunnel** toggle and click **Save & Restart Server**.
3. AeroSync will generate a secure public HTTPS URL (e.g. `https://aerosync-xxxx.localhost.run`) powered by reverse SSH forwarding.
4. Anyone on the internet can scan or visit this public link to upload or download files directly from your computer!

### Solution B: Laptop Hotspot (Host on Laptop)
1. Turn on the Mobile Hotspot feature on your *laptop* instead.
2. Connect your phone/other devices to the laptop's Wi-Fi network.
3. Open the laptop's gateway IP (usually `http://192.168.137.1:5000` or `http://10.42.0.1:5000`) on the phone.

### Solution C: HTTP Server Relay
If direct WebRTC peer connections hang at "Connecting...", WebRTC traffic is blocked by the network. Don't worry! Simply drag the files into the **My Shared Files (Explorer)** window. This uploads the file to the host drive, allowing connected peers to download it at high speeds over HTTP standard protocols.

---

## ☁️ Cloud Deployment (VPS / PaaS)

If you want a 24/7 file sharing relay in the cloud:

### Render / Railway / Heroku
1. Push this repository to GitHub.
2. Link the repository to your chosen service.
3. Configure the deployment details:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment Variable:** Set `PORT` to the port required by the service (usually mapped dynamically).
4. **Important for Cloud instances:** Cloud platforms typically have ephemeral filesystems. If the instance restarts, files in `/app/shared_files` will be deleted. To prevent this, attach a **Persistent Disk/Volume** to the container mapped to `/app/shared_files`.

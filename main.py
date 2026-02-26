import asyncio
import random
import time
from typing import Any, Dict, List, Optional, Tuple

import aiohttp
from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register


def _now_ts() -> int:
    return int(time.time())


def _fmt_duration(sec: int) -> str:
    sec = max(0, int(sec))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    if h > 0:
        return f"{h}h{m}m{s}s"
    return f"{m}m{s}s"


def _safe_int(v: Any, default: int = 0) -> int:
    try:
        return int(v)
    except Exception:
        return default


@register("farm_rank_bot", "Codex", "Farm Ranking & Alert Bot", "3.0.0")
class FarmRankBot(Star):
    def __init__(self, context: Context):
        super().__init__(context)
        self.context = context
        self.bot = None
        # Try to get bot immediately
        if hasattr(context, "get_bot"):
            self.bot = context.get_bot()
        elif hasattr(context, "bot"):
            self.bot = context.bot
        
        # Fallback: Look for adapter/bots in context
        if not self.bot and hasattr(context, "get_bots"):
             bots = context.get_bots()
             if bots:
                 self.bot = bots[0]

        self.api_url = "http://YOUR_SERVER_IP:2222/api/admin"
        self.admin_password = "YOUR_ADMIN_PASSWORD"
        self.token = ""

        self.ERROR_MAP = {
            "remote_login": "该账号在其他设备登录",
            "other_login": "被挤号/异地登录",
            "reconnect_failed": "尝试重连失败，请检查网络",
            "relogin_failed": "自动重新登录失败",
            "password_error": "密码错误或失效",
            "verify_code": "需要验证码/滑块验证",
            "device_lock": "触发设备锁，需验证",
            "network_error": "网络连接中断",
            "timeout": "请求超时",
            "unknown": "未知错误",
        }

        self.cfg: Dict[str, Any] = {}
        self._running = True
        self._last_settings_sync = 0.0
        self._last_push_at = 0.0
        self._last_alert_sig: Dict[str, str] = {}
        self._gain_base: Dict[str, Dict[str, float]] = {}
        self._last_announcement_ts = 0.0

        asyncio.get_event_loop().create_task(self.scheduler_loop())

    # ----------------------------
    # Config
    # ----------------------------
    def default_cfg(self) -> Dict[str, Any]:
        return {
            "enabled": False,
            "adminUrl": "http://YOUR_SERVER_IP:2222",
            "groupId": "",
            "groupIds": "",
            "adText": "想尝试云端代挂？发送 /buy",
            "adIntervalMin": 60,
            "reportIntervalSec": 300,
            "buyText": "云端代挂购买链接：\nhttps://YOUR_SHOP_URL/buy\n\n可私聊管理员获取最新优惠。",
            "alertEnabled": True,
        }

    def merged_cfg(self) -> Dict[str, Any]:
        c = self.default_cfg()
        c.update(self.cfg or {})
        return c

    def parse_group_ids(self) -> List[int]:
        c = self.merged_cfg()
        raw_multi = str(c.get("groupIds") or "").strip()
        raw_single = str(c.get("groupId") or "").strip()
        raw = raw_multi if raw_multi else raw_single
        out: List[int] = []
        for p in raw.replace("，", ",").split(","):
            p = p.strip()
            if not p:
                continue
            try:
                out.append(int(p))
            except Exception:
                continue
        return out

    def bot_enabled(self) -> bool:
        return bool(self.merged_cfg().get("enabled", False))

    def alert_enabled(self) -> bool:
        return bool(self.merged_cfg().get("alertEnabled", True))

    def rank_interval_sec(self) -> int:
        c = self.merged_cfg()
        sec = _safe_int(c.get("reportIntervalSec"), 0)
        if sec > 0:
            return max(30, sec)
        mins = _safe_int(c.get("adIntervalMin"), 0)
        if mins > 0:
            return max(30, mins * 60)
        return 300

    def ad_text(self) -> str:
        text = str(self.merged_cfg().get("adText") or "").strip()
        return text or "想尝试云端代挂？发送 /buy"

    def buy_text(self) -> str:
        text = str(self.merged_cfg().get("buyText") or "").strip()
        return text or "云端代挂购买链接：\nhttps://example.com/buy"

    # ----------------------------
    # HTTP helpers
    # ----------------------------
    async def get_token(self) -> bool:
        login_url = f"{self.api_url}/login"
        logger.info(f"[FarmRankBot] Attempting login at: {login_url}")
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(login_url, json={"password": self.admin_password}, timeout=10) as resp:
                    if resp.status != 200:
                        logger.error(f"[FarmRankBot] Login failed with status {resp.status}")
                        return False
                    js = await resp.json()
                    if js.get("ok") and js.get("token"):
                        self.token = str(js["token"])
                        logger.info(f"[FarmRankBot] Login successful, token acquired")
                        return True
            return False
        except Exception as e:
            logger.error(f"[FarmRankBot] admin login failed: {e}")
            return False

    async def _authed_get(self, path: str) -> Optional[Dict[str, Any]]:
        if not self.token and not await self.get_token():
            return None
        headers = {"Authorization": f"Bearer {self.token}"}
        url = f"{self.api_url}{path}"
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers, timeout=10) as resp:
                    if resp.status == 401:
                        if not await self.get_token():
                            return None
                        headers = {"Authorization": f"Bearer {self.token}"}
                        async with session.get(url, headers=headers, timeout=10) as resp2:
                            if resp2.status != 200:
                                return None
                            return await resp2.json()
                    if resp.status != 200:
                        return None
                    return await resp.json()
        except Exception:
            return None

    async def get_dashboard(self) -> Optional[Dict[str, Any]]:
        js = await self._authed_get("/dashboard")
        if not js or not js.get("ok"):
            return None
        return js.get("data") or {}

    async def sync_settings(self) -> None:
        logger.info("[FarmRankBot] Syncing settings from API...")
        js = await self._authed_get("/settings")
        if not js or not js.get("ok"):
            logger.error(f"[FarmRankBot] Failed to sync settings: {js}")
            return
        settings = js.get("data") or {}
        bot_cfg = settings.get("botConfig") or {}
        self.cfg = bot_cfg
        logger.info(f"[FarmRankBot] Settings synced. enabled={bot_cfg.get('enabled')}, groupIds={bot_cfg.get('groupIds')}")
        admin_url = str(bot_cfg.get("adminUrl") or "").strip()
        if admin_url:
            self.api_url = admin_url.rstrip("/") + "/api/admin"

    # ----------------------------
    # Data shaping
    # ----------------------------
    def _flatten_accounts(self, dashboard: Dict[str, Any]) -> List[Dict[str, Any]]:
        if not dashboard:
            return []
        out: List[Dict[str, Any]] = []
        for card in dashboard.get("cards") or []:
            for acc in card.get("accounts") or []:
                out.append(acc)
        accounts = []
        # 1. Card bound accounts
        cards = dashboard.get("cards") or []
        for card in cards:
            accs = card.get("accounts") or []
            accounts.extend(accs)
        # 2. Unbound accounts
        unbound = dashboard.get("unboundAccounts") or []
        accounts.extend(unbound)
        return accounts

    def _online_accounts(self, dashboard: Dict[str, Any]) -> List[Dict[str, Any]]:
        return [a for a in self._flatten_accounts(dashboard) if str(a.get("status") or "") == "online"]

    def _all_accounts(self, dashboard: Dict[str, Any]) -> List[Dict[str, Any]]:
        return self._flatten_accounts(dashboard)

    def _acc_key(self, acc: Dict[str, Any]) -> str:
        return str(acc.get("id") or f"gid-{acc.get('gid')}")

    def _acc_display(self, acc: Dict[str, Any]) -> str:
        name = str(acc.get("name") or "未知账号")
        qq = str(acc.get("qqNumber") or "").strip()
        platform = str(acc.get("platform") or "qq")
        gid = _safe_int(acc.get("gid"), 0)
        if platform == "qq" and qq:
            return f"{name}(QQ:{qq})"
        if qq:
             return f"{name}(QQ:{qq})"
        return f"{name}(GID:{gid})"

    def _update_gain_base(self, online_accounts: List[Dict[str, Any]]) -> None:
        online_keys = set()
        for acc in online_accounts:
            key = self._acc_key(acc)
            online_keys.add(key)
            gold = float(acc.get("gold") or 0.0)
            exp = float(acc.get("exp") or 0.0)
            if key not in self._gain_base:
                self._gain_base[key] = {"gold_base": gold, "exp_base": exp, "created_at": float(_now_ts())}
        # Clean up offline accounts from gain base?
        # Actually, if we want session gain, we should remove them.
        for key in list(self._gain_base.keys()):
            if key not in online_keys:
                del self._gain_base[key]

    # ----------------------------
    # Ranking builders
    # ----------------------------
    def _rank_level(self, accounts: List[Dict[str, Any]]) -> str:
        # Filter valid level > 0
        valid = [a for a in accounts if _safe_int(a.get("level"), 0) > 0]
        rows = sorted(valid, key=lambda x: _safe_int(x.get("level"), 0), reverse=True)[:10]
        lines = ["🏆 等级排行榜"]
        for i, acc in enumerate(rows, 1):
            lv = _safe_int(acc.get("level"), 0)
            status = "🟢" if str(acc.get("status")) == "online" else "🔴"
            lines.append(f"{i}. {status} {self._acc_display(acc)} · Lv{lv}")
        if len(lines) == 1:
            lines.append("暂无数据。")
        return "\n".join(lines)

    def _rank_online_time(self, accounts: List[Dict[str, Any]]) -> str:
        # Filter runtime > 0
        valid = [a for a in accounts if _safe_int(a.get("runtimeSec"), 0) > 0]
        rows = sorted(valid, key=lambda x: _safe_int(x.get("runtimeSec"), 0), reverse=True)[:10]
        lines = ["⏱ 累计运行时长排行榜"]
        for i, acc in enumerate(rows, 1):
            sec = _safe_int(acc.get("runtimeSec"), 0)
            status = "🟢" if str(acc.get("status")) == "online" else "🔴"
            lines.append(f"{i}. {status} {self._acc_display(acc)} · {_fmt_duration(sec)}")
        if len(lines) == 1:
            lines.append("暂无数据。")
        return "\n".join(lines)

    def _rank_gold_gain(self, online_accounts: List[Dict[str, Any]]) -> str:
        rows: List[Tuple[float, Dict[str, Any]]] = []
        for acc in online_accounts:
            income = acc.get("income") or {}
            gain = float(income.get("gold") or 0.0)
            rows.append((gain, acc))
        rows.sort(key=lambda x: x[0], reverse=True)
        lines = ["💰 金币收益排行榜（本轮在线）"]
        for i, (gain, acc) in enumerate(rows[:10], 1):
            lines.append(f"{i}. {self._acc_display(acc)} · +{int(gain):,}")
        if len(lines) == 1:
            lines.append("暂无可统计数据（账号在线一段时间后再查看）。")
        return "\n".join(lines)

    def _rank_exp_gain(self, online_accounts: List[Dict[str, Any]]) -> str:
        rows: List[Tuple[float, Dict[str, Any]]] = []
        for acc in online_accounts:
            income = acc.get("income") or {}
            gain = float(income.get("exp") or 0.0)
            rows.append((gain, acc))
        rows.sort(key=lambda x: x[0], reverse=True)
        lines = ["📈 经验收益排行榜（本轮在线）"]
        for i, (gain, acc) in enumerate(rows[:10], 1):
            lines.append(f"{i}. {self._acc_display(acc)} · +{int(gain):,}")
        if len(lines) == 1:
            lines.append("暂无可统计数据（账号在线一段时间后再查看）。")
        return "\n".join(lines)

    def _online_summary(self, online_accounts: List[Dict[str, Any]]) -> str:
        lines = [f"👥 当前在线用户数：{len(online_accounts)}"]
        if not online_accounts:
            lines.append("当前没有在线账号。")
            return "\n".join(lines)
        for acc in sorted(online_accounts, key=lambda x: str(x.get("name") or "")):
            lines.append(f"- {self._acc_display(acc)}")
        return "\n".join(lines)

    # ----------------------------
    # Send and alert
    # ----------------------------
    async def send_group_msg(self, group_id: int, text: str) -> None:
        if not self.bot:
            # Retry fetching bot
            if hasattr(self.context, "get_bot"):
                self.bot = self.context.get_bot()
            elif hasattr(self.context, "bot"):
                self.bot = self.context.bot
        
        if not self.bot:
            logger.error("[FarmRankBot] bot instance missing (still None after retry)")
            return

        try:
            await self.bot.send_group_msg(group_id=int(group_id), message=text)
        except Exception as e:
            logger.error(f"[FarmRankBot] send_group_msg failed: {e}")

    async def _push_random_rank(self, dashboard: Dict[str, Any]) -> None:
        group_ids = self.parse_group_ids()
        if not group_ids:
            return
        online = self._online_accounts(dashboard)
        all_accs = self._all_accounts(dashboard)

        self._update_gain_base(online)

        def rank_level_wrapper(_): return self._rank_level(all_accs)
        def rank_time_wrapper(_): return self._rank_online_time(all_accs)
        def rank_gold_wrapper(_): return self._rank_gold_gain(online)
        def rank_exp_wrapper(_): return self._rank_exp_gain(online)
        def online_summary_wrapper(_): return self._online_summary(online)

        builders = [
            rank_level_wrapper,
            rank_time_wrapper,
            rank_gold_wrapper,
            rank_exp_wrapper,
            online_summary_wrapper,
        ]
        text = random.choice(builders)(None)
        final_text = f"{text}\n\n{self.ad_text()}"
        for gid in group_ids:
            await self.send_group_msg(gid, final_text)

    async def _check_alerts(self, dashboard: Dict[str, Any]) -> None:
        if not self.alert_enabled():
            return
        group_ids = self.parse_group_ids()
        if not group_ids:
            return


        # 遍历所有账号，检查是否需要发送告警
        for acc in self._flatten_accounts(dashboard):
            status = str(acc.get("status") or "")
            reason = str(acc.get("statusReason") or "").strip()
            if not reason and status == "online":
                continue

            key = self._acc_key(acc)
            sig = f"{status}|{reason}"
            if self._last_alert_sig.get(key) == sig:
                continue
            self._last_alert_sig[key] = sig

            reason_low = reason.lower()
            is_alert = (
                ("remote_login" in reason_low)
                or ("reconnect_failed" in reason_low)
                or ("error" in reason_low)
                or (status in ("offline", "error") and reason)
            )
            if not is_alert:
                continue

            title = "⚠ 账号状态告警"
            error_desc = self.ERROR_MAP.get(reason_low, reason)
            
            # 尝试通过关键词匹配 ERROR_MAP
            if not error_desc or error_desc == reason:
                for k, v in self.ERROR_MAP.items():
                    if k in reason_low:
                        error_desc = v
                        break

            if "remote_login" in reason_low:
                title = "🚨 异地登录告警"
            elif "reconnect_failed" in reason_low:
                title = "🚨 重连失败告警"
            elif "password" in reason_low or "verify" in reason_low:
                title = "🔑 密码/验证码错误"
            elif "network" in reason_low or "timeout" in reason_low:
                title = "🌐 网络连接超时"

            # 用户偏好的格式
            from datetime import datetime
            time_str = datetime.now().strftime('%H:%M')
            qq_num = str(acc.get("qqNumber") or "")
            account_id = str(acc.get("id") or "")
            note = self._acc_display(acc)
            final_reason = title
            matched_raw = reason
            
            logger.info(f"[FarmRankBot] Alert Triggered for {qq_num}: {reason_low}")

            content = (
                f"⛈️ 【庄园灾害预警】\n"
                f"伙计: {note} (工号:{account_id})\n"
                f"判定: {final_reason} ({error_desc})\n"
                f"原始: {matched_raw}\n"
                f"时间: {time_str}\n"
                f"处理: 已将该伙计遣返。"
            )

            # 获取 QQ 号用于 @ 提醒（如果有的话）
            at_qq = str(acc.get("qqNumber") or "").strip()
            
            # 发送告警到所有配置的群
            for gid in group_ids:
                # 使用 CQ 码格式，参考 main_example.py
                msg = content
                if at_qq:
                    msg = f"[CQ:at,qq={at_qq}]\n{content}"
                
                await self.send_group_msg(gid, msg)

    async def _check_announcement(self) -> None:
        group_ids = self.parse_group_ids()
        if not group_ids:
            return

        # Use base API URL (remove /admin suffix if present)
        base_url = self.api_url.replace("/api/admin", "/api")
        url = f"{base_url}/system/announcement"
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, timeout=10) as resp:
                    if resp.status != 200:
                        return
                    js = await resp.json()
                    if not js or not js.get("ok"):
                        return
                    data = js.get("data") or {}
        except Exception as e:
            logger.error(f"[FarmRankBot] check announcement failed: {e}")
            return

        if not data.get("enabled"):
            return
            
        content = str(data.get("content") or "").strip()
        update_time = float(data.get("updatedAt") or 0)
        level = str(data.get("level") or "info")
        
        # Only push if it's a new update (buffer 10s to avoid duplicate if clock skew?)
        # Actually just strictly greater
        if update_time > self._last_announcement_ts and self._last_announcement_ts > 0:
            logger.info(f"[FarmRankBot] New announcement detected: {content[:20]}...")
            
            prefix = "📢 公告"
            if level == "warning": prefix = "⚠️ 重要通知"
            if level == "alert": prefix = "🚨 紧急警报"
            
            msg = f"{prefix}\n━━━━━━━━━━━━━━━\n{content}\n━━━━━━━━━━━━━━━\n"
            
            for gid in group_ids:
                await self.send_group_msg(gid, msg)
        
        # Update timestamp (even if we didn't push because it was the first fetch)
        # On startup we don't push old announcements, only new ones starting now.
        if self._last_announcement_ts == 0.0:
             self._last_announcement_ts = update_time
        else:
             self._last_announcement_ts = max(self._last_announcement_ts, update_time)

    # ----------------------------
    # Scheduler
    # ----------------------------
    async def scheduler_loop(self) -> None:
        await asyncio.sleep(2)
        while self._running:
            now = time.time()
            try:
                # 每5分钟同步一次配置（降低频率）
                if now - self._last_settings_sync >= 300:
                    await self.sync_settings()
                    self._last_settings_sync = now

                if not self.bot_enabled():
                    await asyncio.sleep(5)
                    continue

                dashboard = await self.get_dashboard()
                if dashboard:
                    await self._check_alerts(dashboard)
                    await self._check_announcement()
                    if now - self._last_push_at >= self.rank_interval_sec():
                        await self._push_random_rank(dashboard)
                        self._last_push_at = now
            except Exception as e:
                logger.error(f"[FarmRankBot] scheduler error: {e}")

            await asyncio.sleep(2)

    # ----------------------------
    # Commands
    # ----------------------------
    @filter.command("功能")
    async def function_cmd(self, event: AstrMessageEvent):
        """展示所有功能图片"""
        # 从配置读取
        image_url = str(self.merged_cfg().get("functionImageUrl") or "").strip()
        text = str(self.merged_cfg().get("functionText") or "").strip()
        
        if not image_url:
            # 默认图
            image_url = "https://oss.nbtab.com/public/xxoo/d34d5084-be02-475e-8441-b38f1ed12944.jpg"

        msg = f"[CQ:image,file={image_url}]"
        if text:
            msg += f"\n{text}"
            
        yield event.plain_result(msg)

    @filter.command("buy")
    async def buy_cmd(self, event: AstrMessageEvent):
        if not self.bot and hasattr(event, "bot"):
            self.bot = event.bot
            logger.info("[FarmRankBot] Captured bot instance from buy_cmd")
        
        text = (
            "📦 云端代挂购买通道\n"
            f"{self.buy_text()}\n\n"
            "如需多开/定制功能，请联系管理员。"
        )
        yield event.plain_result(text)

    @filter.command("在线人数")
    async def online_cmd(self, event: AstrMessageEvent):
        if not self.bot and hasattr(event, "bot"):
            self.bot = event.bot
            logger.info("[FarmRankBot] Captured bot instance from online_cmd")

        dashboard = await self.get_dashboard()
        if not dashboard:
            yield event.plain_result("读取在线数据失败，请稍后重试。")
            return
        online = self._online_accounts(dashboard)
        yield event.plain_result(self._online_summary(online))

    @filter.command("排行榜")
    async def rank_cmd(self, event: AstrMessageEvent):
        if not self.bot and hasattr(event, "bot"):
            self.bot = event.bot
            logger.info("[FarmRankBot] Captured bot instance from rank_cmd")

        dashboard = await self.get_dashboard()
        if not dashboard:
            yield event.plain_result("读取排行榜失败，请稍后重试。")
            return
        online = self._online_accounts(dashboard)
        self._update_gain_base(online)
        # 添加当前时间戳
        from datetime import datetime
        current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        timestamp_header = f"📅 {current_time}\n━━━━━━━━━━━━━━━\n"
        
        text = "\n\n".join(
            [
                self._rank_level(online),
                self._rank_online_time(online),
                self._rank_gold_gain(online),
                self._rank_exp_gain(online),
            ]
        )
        yield event.plain_result(f"{timestamp_header}{text}\n\n{self.ad_text()}")

    @filter.command("状态")
    async def test_cmd(self, event: AstrMessageEvent):
        """测试指令：检查机器人状态和连接"""
        if not self.bot and hasattr(event, "bot"):
            self.bot = event.bot
            logger.info("[FarmRankBot] Captured bot instance from test_cmd")
        
        # 检查机器人是否启用
        enabled = self.bot_enabled()
        status = "✅ 已启用" if enabled else "❌ 未启用"
        
        # 检查配置的群组
        group_ids = self.parse_group_ids()
        groups_info = f"配置群组: {', '.join(map(str, group_ids))}" if group_ids else "未配置群组"
        
        # 尝试获取dashboard数据
        dashboard = await self.get_dashboard()
        api_status = "✅ API连接正常" if dashboard else "❌ API连接失败"
        
        # 统计在线账号数
        online_count = 0
        total_accounts = 0
        if dashboard:
            online = self._online_accounts(dashboard)
            online_count = len(online)
            total_accounts = sum(len(c.get("accounts", [])) for c in dashboard.get("cards", []))
        
        # 构建响应文本
        text = (
            "🤖 机器人测试报告\n"
            f"━━━━━━━━━━━━━━━\n"
            f"状态: {status}\n"
            f"{groups_info}\n"
            f"{api_status}\n"
            f"在线账号: {online_count}/{total_accounts}\n"
            f"━━━━━━━━━━━━━━━\n"
            f"配置URL: {self.api_url}\n"
            f"Token: {'已设置' if self.token else '未设置'}\n"
            f"推送间隔: {self.rank_interval_sec()}秒"
        )
        
        yield event.plain_result(text)


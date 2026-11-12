// SPDX-License-Identifier: Apache-2.0
// Interface language layer. The app renders English; when Chinese is selected
// this translates text and labels as they enter the page. Text inside
// [data-raw] (course names, to-dos, chat messages) is never touched.
(function (root) {
  'use strict';
  const ZH = {
    // Navigation and chrome
    'Home': '主页', 'Schedule': '课表', 'Progress': '成绩', 'Assistant': 'AI 助手', 'Forum': '论坛', 'Tools': '工具', 'Settings': '设置',
    'YOUR WORKSPACE': '你的工作区', 'Saved on your Mac': '已保存在这台 Mac 上', 'Browser preview': '浏览器预览', 'Skip to content': '跳到正文',
    'Application sidebar': '应用侧边栏', 'Main navigation': '主导航', 'WLSAPlus home': 'WLSAPlus 主页', 'Loading your workspace…': '正在载入你的工作区…',
    'PowerSchool not synced': 'PowerSchool 尚未同步', 'Sync PowerSchool': '同步 PowerSchool', 'PowerSchool account': 'PowerSchool 账户', 'Connect PowerSchool': '连接 PowerSchool',
    'Notice': '通知', 'Dismiss notice': '关闭通知', 'Close': '关闭', 'Close dialog': '关闭对话框', 'Cancel': '取消', 'Done': '完成', 'Clear': '清除', 'Status': '状态',
    'Browser preview · Native Mac services are unavailable. Connect, sync, VPN, translation and saving require WLSAPlus.app. No school data is loaded.': '浏览器预览 · 原生 Mac 服务不可用。连接、同步、VPN、翻译和保存需要在 WLSAPlus.app 中使用。未载入任何学校数据。',
    // Home
    'Good morning': '早上好', 'Good afternoon': '下午好', 'Good evening': '晚上好', 'YOUR SCHOOL, CONNECTED': '你的学校，尽在掌握',
    'Your school day, at a glance.': '一眼看清今天的学校生活。', 'Make room for a better school day.': '让每一天的学习更从容。', 'Your school day, brought together.': '把学校的一天汇集在一起。',
    'Your timetable, assignments and campus essentials, together in one place. Your last sync stays available offline.': '课表、作业和校园常用功能集中在一处。上次同步的数据离线也能查看。',
    'Connect PowerSchool to bring your classes, grades and attendance into your workspace.': '连接 PowerSchool，把课程、成绩和考勤带进你的工作区。',
    'View schedule': '查看课表', 'Classes today': '今日课程', 'Assignments due today': '今日到期作业', 'To-dos remaining': '未完成待办',
    "Today's schedule": '今日课表', 'Today’s classes': '今日课程', 'View all': '查看全部', 'Upcoming assignments': '即将到期的作业', 'Your to-dos': '你的待办',
    'No classes to show': '没有可显示的课程', 'There are no synced classes for this date.': '这一天没有已同步的课程。', 'Your classes will appear after you connect PowerSchool.': '连接 PowerSchool 后会显示你的课程。',
    'Nothing coming up': '近期没有作业', 'Upcoming dated assignments from PowerSchool appear here.': 'PowerSchool 中有截止日期的作业会显示在这里。',
    'CURRENT CLASS': '正在上课', 'NEXT CLASS': '下一节课', 'Class': '课程', 'Class progress': '课程进度', 'minutes remaining': '分钟后下课', 'remaining': '后下课', 'minutes until class': '分钟后上课', 'until class': '后上课',
    'Up next': '接下来', 'After that': '再之后', 'Your next synchronized class.': '已同步课表中的下一节课。', 'A little time before your next class.': '离下一节课还有一点时间。',
    'Planning timeline': '计划时间线', 'Planning timeline, scroll horizontally for details': '计划时间线，可横向滚动查看', 'Classes, assignments and your to-do deadlines.': '课程、作业和待办的截止时间。',
    'Previous timeline window': '上一段时间', 'Next timeline window': '下一段时间', 'Now': '现在', 'Zoom in': '放大', 'Zoom out': '缩小', 'A little room in your timeline': '这段时间比较空',
    'No dated classes, assignments or active to-dos fall in this window. Add a to-do deadline, sync PowerSchool, or move to another date.': '这段时间内没有课程、作业或待办。可以添加待办截止时间、同步 PowerSchool，或换一个日期。',
    'Assignment': '作业', 'Assignment deadline': '作业截止', 'Due date · time not provided': '截止日期 · 未提供时间', 'To-do deadline': '待办截止', 'To-do deadlines': '待办截止', 'Scheduled to-do': '已安排的待办',
    'Classes': '课程', '· Dates without a time appear at the start of that day.': '· 没有具体时间的日期显示在当天开始处。', 'Display time is set to': '显示时间设为', '. Notifications use the actual time.': '。通知仍按实际时间发送。',
    // Schedule
    'A little structure for your school day.': '让一天的学习井井有条。', 'Sync schedule': '同步课表', 'Previous': '上一个', 'Next': '下一个', 'Today': '今天', 'Tomorrow': '明天', 'Day': '日', 'Week': '周', 'Schedule view': '课表视图',
    'Your schedule starts here': '课表从这里开始', 'Connect PowerSchool or sync your account to see your timetable.': '连接 PowerSchool 或同步账户后即可查看课表。', 'No classes': '没有课', 'A clear day': '今天没有课',
    'No classes were provided by PowerSchool for this date.': 'PowerSchool 没有提供这一天的课程。', 'Classes without a date': '未注明日期的课程', 'PowerSchool did not provide a usable day for these entries.': 'PowerSchool 没有为这些课程提供可用的日期。',
    'Untitled class': '未命名课程', 'Room not provided': '未提供教室', 'Find room': '查找教室', 'No synchronized timetable yet.': '还没有同步课表。',
    'Monday': '周一', 'Tuesday': '周二', 'Wednesday': '周三', 'Thursday': '周四', 'Friday': '周五', 'Saturday': '周六', 'Sunday': '周日',
    // Progress
    'See the details behind your school day.': '查看学习情况的详细数据。', 'Sync progress': '同步成绩', 'Progress section': '成绩分区', 'Grades': '成绩', 'Assignments': '作业', 'Attendance': '考勤',
    'Filter by course': '按课程筛选', 'All courses': '全部课程', 'Search progress': '搜索', 'Your courses will appear here': '你的课程会显示在这里', 'Connect PowerSchool and sync to see your course grades.': '连接 PowerSchool 并同步后即可查看各科成绩。',
    'No matching courses': '没有匹配的课程', 'Try searching by course or teacher.': '试试按课程或老师搜索。', 'Untitled course': '未命名课程', 'Teacher not provided': '未提供任课老师', 'No percentage': '暂无百分比',
    'No assignments to show': '没有可显示的作业', 'Assignments and their scores appear after a PowerSchool sync.': '同步 PowerSchool 后会显示作业及分数。', 'No matching assignments': '没有匹配的作业',
    'No attendance records': '没有考勤记录', 'Attendance records from PowerSchool appear here.': 'PowerSchool 的考勤记录会显示在这里。', 'No matching attendance': '没有匹配的考勤记录',
    'Grades and attendance reflect your last PowerSchool sync. Select a course to view its description, assignments and teacher comments.': '成绩和考勤以上次 PowerSchool 同步为准。点选课程可查看课程说明、作业和老师评语。',
    'Course': '课程', 'Score': '分数', 'Due': '截止', 'Date': '日期', 'Untitled assignment': '未命名作业', 'Course not provided': '未提供课程', 'Not graded': '未评分', 'Not provided': '未提供', 'No due date': '无截止日期', 'Due date passed': '已过截止日期',
    'Course details': '课程详情', 'Loading course details…': '正在载入课程详情…', 'Course description': '课程说明', 'Teacher comment': '老师评语', 'No assignment details were provided for this course.': '这门课没有提供作业详情。',
    'This course is no longer in your last sync.': '上次同步的数据里已没有这门课。', 'Your last synchronized course grade is': '上次同步的课程成绩是', 'Unspecified': '未注明', 'Since': '自',
    // Assistant
    'Ask about your classes, grades, rooms and teachers.': '问问你的课程、成绩、教室和老师。', 'How to use the assistant': '使用方法',
    'Type a question in English or Chinese, or pick an example below.': '用中文或英文输入问题，也可以直接点下面的示例。',
    'Answers about your timetable, grades, rooms and teachers are read directly from your synced PowerSchool data, and the data used is shown under each answer.': '关于课表、成绩、教室和老师的回答直接取自已同步的 PowerSchool 数据，每条回答下方会列出所用的数据。',
    'The model runs on this Mac. Your questions and school data never leave it.': '模型在这台 Mac 上运行，你的问题和学校数据不会离开本机。',
    'For the full tables, use the Grades, Assignments and Attendance tabs above.': '想看完整表格，请用上方的“成绩”“作业”“考勤”标签页。',
    'Try asking': '试试这样问', 'Ask a question…': '输入问题…', 'Ask the assistant': '向助手提问', 'Ask': '提问', 'Thinking…': '思考中…', 'Conversation': '对话', 'Your conversation appears here': '对话会显示在这里',
    'Ask something, or pick one of the examples above.': '输入问题，或点选上面的示例。', 'Clear conversation': '清空对话', 'The assistant is ready': 'AI 助手已就绪', 'Reopen WLSAPlus to turn on the on-device assistant.': '重新打开 WLSAPlus 即可启用本机 AI 助手。', 'Reopen now': '立即重新打开',
    // Assistant settings
    'On-device assistant': '本机 AI 助手', 'Language': '语言', 'Choose the language of the interface.': '选择界面语言。', '中文': '中文',
    'The assistant needs a Mac with Apple silicon.': 'AI 助手需要搭载 Apple 芯片的 Mac。', 'The assistant needs a Mac with 16 GB of memory or more.': 'AI 助手需要 16 GB 或以上内存的 Mac。',
    'The assistant model (1.1 GB) downloads automatically in the background.': '助手模型（1.1 GB）会在后台自动下载。', 'Downloading the assistant model (1.1 GB)…': '正在下载助手模型（1.1 GB）…', 'Checking the downloaded model…': '正在校验下载的模型…',
    'Download paused. Resume whenever you like.': '下载已暂停，可随时继续。', 'The assistant model could not be downloaded. WLSAPlus will try again later.': '助手模型下载失败，WLSAPlus 稍后会重试。',
    'The assistant is ready. Reopen WLSAPlus to turn it on.': 'AI 助手已就绪，重新打开 WLSAPlus 即可启用。', 'The assistant is on. Open the Assistant page to ask a question.': 'AI 助手已启用，打开“AI 助手”页面即可提问。',
    'Pause download': '暂停下载', 'Resume download': '继续下载', 'Try again': '重试', 'Model download progress': '模型下载进度', 'Open assistant': '打开 AI 助手',
    // Forum
    'A space for your school community.': '属于你们学校的交流空间。', 'Good conversations start here.': '好的讨论从这里开始。', 'Open forum': '打开论坛', 'Opening forum…': '正在打开论坛…',
    'Explore the WLSAPlus forum, share ideas and see what your school community is talking about. The forum opens inside WLSAPlus.': '逛逛 WLSAPlus 论坛，分享想法，看看同学们在聊什么。论坛会在 WLSAPlus 内打开。',
    'Separate forum session': '独立的论坛会话', 'Follows your appearance': '跟随外观设置', 'Anonymous posts': '匿名发帖',
    'Your current PowerSchool session can be used to sign in. Your password is not sent to the forum.': '可用当前的 PowerSchool 会话登录，密码不会发送给论坛。', 'Connect PowerSchool in Settings to enable forum sign-in.': '在设置中连接 PowerSchool 后即可登录论坛。',
    // Tools
    'Small essentials. A little more ease.': '几个小工具，多一点方便。', 'All tools': '全部工具', 'VPN': 'VPN', 'Translator': '翻译', 'Campus map': '校园地图', 'To-dos': '待办',
    'Choose a node, test latency and manage your connection.': '选择节点、测试延迟并管理连接。', 'A little help finding the right words, in another language.': '帮你用另一种语言找到合适的表达。',
    'Open the campus map and look up a classroom.': '打开校园地图，查找教室。', 'Keep track of what you want to get done.': '记录想完成的事情。', 'Network': '网络', 'Languages': '语言', 'Find your way': '找路', 'Stay organized': '井井有条',
    'Your connection, in your control.': '你的连接，由你掌控。', 'Make yourself understood.': '让表达更准确。', 'Find your way around campus': '在校园里找到方向', 'One thing at a time.': '一件一件来。',
    // VPN
    'Connected': '已连接', 'Not connected': '未连接', 'Connecting…': '正在连接…', 'Disconnecting…': '正在断开…', 'Connect': '连接', 'Disconnect': '断开', 'Native VPN is active.': '原生 VPN 已启用。', 'Using': '正在使用',
    'A connected status is shown only when the native VPN service confirms it. macOS may request network permissions.': '只有原生 VPN 服务确认后才会显示已连接。macOS 可能会请求网络权限。',
    'Subscription': '订阅', 'No subscription yet': '还没有订阅', 'Add a Clash subscription': '添加 Clash 订阅', 'Add subscription': '添加订阅', 'Change subscription': '更换订阅', 'Remove subscription': '移除订阅', 'Save subscription': '保存订阅',
    'Add a subscription to get started.': '添加订阅后即可开始。', 'Add a Clash subscription URL above to load available nodes.': '在上方添加 Clash 订阅地址以载入节点。', 'Add a Clash subscription URL before loading nodes.': '请先添加 Clash 订阅地址再载入节点。',
    'Clash subscription URL': 'Clash 订阅地址', 'Use a Clash HTTPS subscription URL.': '请使用 HTTPS 的 Clash 订阅地址。', 'Nodes are fetched from this Clash HTTPS subscription and stored only on this Mac.': '节点从这个 Clash HTTPS 订阅获取，只保存在这台 Mac 上。',
    'Only https:// URLs are accepted. The URL is saved on this Mac and used to fetch Clash proxy nodes.': '只接受 https:// 地址。地址保存在这台 Mac 上，用于获取 Clash 代理节点。',
    'Subscription saved.': '订阅已保存。', 'Subscription removed.': '订阅已移除。', 'Available nodes': '可用节点', 'No VPN nodes available': '没有可用的 VPN 节点', 'Refresh nodes': '刷新节点', 'Fetching subscription nodes…': '正在获取订阅节点…',
    'Refresh to load nodes from your subscription. The native service reports any configuration or connection errors.': '刷新以从订阅载入节点。配置或连接出错时原生服务会给出提示。',
    'Choose a node to get started.': '选择一个节点开始。', 'VPN node': 'VPN 节点', 'Test latency': '测试延迟', 'Latency test completed.': '延迟测试完成。', 'Not tested': '未测试', 'Recover network': '恢复网络',
    'Connection checks': '连接检查', 'Check WeChat': '检查微信', 'Check whether WeChat is reachable with your current network connection.': '检查当前网络能否访问微信。', 'WeChat is reachable.': '可以访问微信。', 'WeChat is not reachable on this connection.': '当前网络无法访问微信。',
    'The native check returned no reachability information.': '原生检查没有返回可达性信息。',
    // Translator
    'Translate': '翻译', 'Translate from': '源语言', 'Translate to': '目标语言', 'Translating…': '正在翻译…', 'Translation': '译文', 'Original text': '原文', 'Detect language': '自动检测', 'Detected:': '检测到：', 'Swap languages': '交换语言',
    'Enter text to translate…': '输入要翻译的文字…', 'Enter some text to translate.': '请输入要翻译的文字。', 'Your translation appears here.': '译文会显示在这里。', 'Copy translation': '复制译文', 'Translation copied.': '译文已复制。', 'Translation ready.': '翻译完成。',
    'Copy was unavailable. Select the translation and copy it manually.': '无法自动复制，请选中译文手动复制。', 'Choose different source and target languages.': '请选择不同的源语言和目标语言。', 'Keep the text under 10,000 characters.': '文字请控制在 10,000 字符以内。',
    'Text is sent to Google Translate. MyMemory is used if Google is unavailable.': '文字会发送给 Google 翻译；Google 不可用时使用 MyMemory。', 'The translation provider returned no translation.': '翻译服务没有返回译文。',
    'English': '英语', 'Chinese (Simplified)': '中文（简体）', 'Chinese (Traditional)': '中文（繁体）', 'Japanese': '日语', 'Korean': '韩语', 'French': '法语', 'German': '德语', 'Spanish': '西班牙语', 'Italian': '意大利语', 'Portuguese': '葡萄牙语', 'Russian': '俄语', 'Arabic': '阿拉伯语',
    // Map
    'Campus directory': '校园指南', 'Find your next classroom.': '找到下一节课的教室。', 'Room or classroom': '教室', 'Enter a room name or number': '输入教室名称或编号', 'Open campus map': '打开校园地图', 'Decorative drawing of a campus, not a floor plan': '校园示意图，并非精确平面图',
    // To-dos
    'Add a to-do': '添加待办', 'Add a to-do…': '添加待办…', 'Add to-do': '添加待办', 'What would you like to get done?': '想完成什么？', 'More options': '更多选项', 'All': '全部', 'Active': '进行中', 'Completed': '已完成', 'Complete': '完成', 'Mark incomplete': '标为未完成',
    'To-do filter': '待办筛选', 'Clear completed': '清除已完成', 'Completed to-dos cleared.': '已清除完成的待办。', 'Completed to-dos appear here.': '完成的待办会显示在这里。', 'No completed to-dos yet': '还没有完成的待办', 'You’re all caught up': '全部完成了',
    'A clear space for your next idea': '给下一个想法留出空间', 'Add a task above, or choose More options to add a time, color and icon.': '在上方添加任务，或点“更多选项”设置时间、颜色和图标。', 'Make a little plan for what comes next.': '为接下来的事做个小计划。',
    'To-dos are saved by the native service on your Mac.': '待办由原生服务保存在你的 Mac 上。', 'Edit to-do': '编辑待办', 'Delete to-do': '删除待办', 'Save to-do': '保存待办', 'To-do': '待办', 'Title': '标题', 'Details': '详情', '(optional)': '（可选）',
    'Notes, links or anything you want to remember…': '备注、链接或任何想记住的内容…', 'Time type': '时间类型', 'Deadline': '截止时间', 'Scheduled': '计划时间', 'Scheduled time': '计划时间', 'Date and time': '日期和时间', 'End': '结束', 'Color': '颜色', 'Icon': '图标',
    'To-do color': '待办颜色', 'To-do icon': '待办图标', 'To-do added.': '待办已添加。', 'To-do saved.': '待办已保存。', 'To-do deleted.': '待办已删除。', 'To-do moved.': '待办已移动。', 'To-do order saved.': '待办顺序已保存。',
    'Enter a title for your to-do.': '请输入待办标题。', 'Keep the to-do title under 500 characters.': '待办标题请控制在 500 字符以内。', 'Keep to-do details under 20,000 characters.': '待办详情请控制在 20,000 字符以内。', 'Choose a valid date and time.': '请选择有效的日期和时间。', 'Invalid to-do.': '待办无效。',
    'A little space to plan': '留一点空间做计划', 'Add a to-do for anything you want to remember.': '把想记住的事加成待办。',
    'Paste an https:// Clash subscription URL to load VPN nodes. Source builds start empty; release builds may suggest a default URL.': '粘贴 https:// 的 Clash 订阅地址以载入 VPN 节点。源码构建默认留空，发布版可能会给出建议地址。',
    // Settings
    'Make WLSAPlus feel like you.': '把 WLSAPlus 调成你喜欢的样子。', 'PowerSchool': 'PowerSchool', 'Connect your school account': '连接学校账户', 'Bring your schedule, grades and attendance into WLSAPlus.': '把课表、成绩和考勤带进 WLSAPlus。',
    'Manage account': '管理账户', 'Manage your school connection.': '管理学校账户连接。', 'Sync now': '立即同步', 'Last sync': '上次同步', 'Appearance': '外观', 'Theme': '主题', 'Follow your Mac, or choose the look you prefer.': '跟随系统，或选择你喜欢的外观。',
    'System': '跟随系统', 'Light': '浅色', 'Dark': '深色', 'Accent color': '强调色', 'A little color throughout your workspace.': '给工作区添一点颜色。', 'Teal': '青色', 'Blue': '蓝色', 'Purple': '紫色', 'Green': '绿色', 'Orange': '橙色', 'Red': '红色', 'Pink': '粉色', 'Rose': '玫红', 'Yellow': '黄色',
    'Notifications & startup': '通知与启动', 'Class reminders': '上课提醒', 'Receive a macOS notification about five minutes before class. Notification permission may be requested.': '上课前约五分钟收到 macOS 通知，可能会请求通知权限。', 'Class reminders are off.': '上课提醒已关闭。',
    'Open at login': '登录时打开', 'Start WLSAPlus when you sign in to your Mac.': '登录 Mac 时自动启动 WLSAPlus。', 'Time tuning': '时间调校', 'Use a custom display time': '使用自定义显示时间',
    'Preview your school day at another time. Class reminders always use the actual time.': '预览其他时间的课程安排。上课提醒始终按实际时间发送。', 'Display date and time': '显示的日期和时间', 'Current display time': '当前显示时间', 'Save display time': '保存显示时间',
    'About & updates': '关于与更新', 'Check for the latest version of WLSAPlus.': '检查 WLSAPlus 的最新版本。', 'Check for updates': '检查更新', 'Checking…': '正在检查…', 'Download update': '下载更新', 'Install update': '安装更新', 'Update log': '更新日志',
    'Update channel': '更新通道', 'Update channel:': '更新通道：', 'Stable': '稳定版', 'Beta / test': '测试版', 'Stable releases are the default. Beta includes test releases and early changes.': '默认使用稳定版。测试版包含测试发布和较早的改动。',
    'Update download progress': '更新下载进度', 'Download and installation details.': '下载和安装的详细记录。', 'Reading update log…': '正在读取更新日志…', 'No update activity has been recorded.': '还没有更新记录。', 'Update check completed.': '更新检查完成。',
    'The update log was revealed in Finder. Open update.log to view its contents.': '已在访达中显示更新日志，打开 update.log 即可查看。', 'Version unavailable': '版本未知',
    'Project & privacy': '项目与隐私', 'School data and to-dos are stored on this Mac. Passwords are handled by the native credential service.': '学校数据和待办保存在这台 Mac 上，密码由原生凭据服务处理。', 'Project on GitHub': 'GitHub 上的项目',
    'Clear local data': '清除本地数据', 'Clear local data…': '清除本地数据…', 'Clear local data?': '清除本地数据？', 'Remove the saved account, cached school data and to-dos from this Mac.': '从这台 Mac 上移除已保存的账户、缓存的学校数据和待办。',
    'The saved PowerSchool account, cached school records and to-dos will be removed. You can reconnect your account afterwards.': '将移除已保存的 PowerSchool 账户、缓存的学校记录和待办。之后可以重新连接账户。', 'This removes the saved data from this Mac.': '这会移除这台 Mac 上保存的数据。',
    'Local data cleared.': '本地数据已清除。', 'Settings saved.': '设置已保存。',
    // Account
    'PowerSchool address': 'PowerSchool 地址', 'Username': '用户名', 'Password': '密码', 'Connect & sync': '连接并同步', 'Sign out': '退出登录', 'Signed out of PowerSchool.': '已退出 PowerSchool。',
    'Use your school’s student and parent portal address.': '请使用学校的学生和家长门户地址。', 'Credentials are passed directly to the native service. The interface does not store your password.': '凭据直接交给原生服务，界面不保存你的密码。',
    'Your schedule, grades and attendance are cached on your Mac for offline access.': '课表、成绩和考勤会缓存在你的 Mac 上，离线也能查看。', 'PowerSchool connected and synchronized.': 'PowerSchool 已连接并同步。', 'PowerSchool synchronized.': 'PowerSchool 已同步。',
    'Enter a complete PowerSchool address, beginning with https://.': '请输入以 https:// 开头的完整 PowerSchool 地址。', 'Use your school’s secure https:// PowerSchool address.': '请使用学校的 https:// 安全 PowerSchool 地址。', 'Enter your PowerSchool username.': '请输入 PowerSchool 用户名。',
    // Errors
    'The request failed.': '请求失败。', 'The request was cancelled.': '请求已取消。', 'The native service did not respond. Please try again.': '原生服务没有响应，请重试。',
    'The native Mac service is unavailable in this browser preview. Open WLSAPlus.app to use this feature.': '浏览器预览中无法使用原生 Mac 服务，请在 WLSAPlus.app 中使用此功能。',
    'The assistant is not available yet.': 'AI 助手暂时不可用。', 'The assistant is still answering the previous question.': 'AI 助手还在回答上一个问题。',
  };
  const PATTERNS = [
    [/^Synced (.+)$/, '已同步 $1'], [/^Last sync (.+)$/, '上次同步 $1'], [/^(Good (?:morning|afternoon|evening)), (.+)$/, (_, greeting, name) => `${ZH[greeting]}，${name}`],
    [/^Display time is set to (.+)\. Notifications use the actual time\.$/, '显示时间设为 $1。通知仍按实际时间发送。'],
    [/^(\d+) hours$/, '$1 小时'], [/^Due today$/, '今天截止'], [/^Due tomorrow$/, '明天截止'], [/^Due in (\d+) days$/, '$1 天后截止'], [/^Due (.+)$/, '$1 截止'], [/^(\d+) days? overdue$/, '已逾期 $1 天'], [/^Overdue$/, '已逾期'],
    [/^Detected: (.+)$/, (_, name) => `检测到：${ZH[name] || name}`], [/^Update channel: (.+)$/, (_, name) => `更新通道：${ZH[name] || name}`], [/^Your last synchronized course grade is (.+)$/, '上次同步的课程成绩是 $1'],
    [/^Could not load native state: (.+)$/, '无法载入原生状态：$1'], [/^Search (grades|assignments|attendance)…$/, (_, kind) => `搜索${({grades: '成绩', assignments: '作业', attendance: '考勤'})[kind]}…`],
    [/^(\d+) events?$/, '$1 项'], [/^(\d+) class(?:es)?$/, '$1 节课'], [/^Version (.+)$/, '版本 $1'],
    [/^(.+) · Due date · time not provided$/, '$1 · 截止日期 · 未提供时间'], [/^(.+) · Assignment deadline$/, '$1 · 作业截止'],
    [/^(?:Last synchronized (.+) at (.+)\.|No synchronized timetable yet\.) (Class reminders are enabled; macOS will notify you about five minutes before class\.|Class reminders are off\.)$/,
      (_, date, time, reminders) => `${date ? `上次同步：${date} ${time}。` : '还没有同步课表。'}${reminders.includes('enabled') ? '上课提醒已开启，macOS 会在上课前约五分钟通知你。' : '上课提醒已关闭。'}`],
    [/^(\d+) ms$/, '$1 毫秒'], [/^Downloading WLSAPlus (.+)…$/, '正在下载 WLSAPlus $1…'], [/^WLSAPlus is up to date\.$/, 'WLSAPlus 已是最新版本。'], [/^Checking for updates…$/, '正在检查更新…'], [/^Ready to check for updates\.$/, '可以检查更新。'],
    [/^Update ready — restart to install WLSAPlus (.+)\.$/, '更新已就绪，重新启动即可安装 WLSAPlus $1。'],
  ];
  const ATTRIBUTES = ['title', 'aria-label', 'placeholder'];
  const textOriginal = new WeakMap(), attributeOriginal = new WeakMap();
  let language = 'en', observer = null;

  function translate(value) {
    const trimmed = String(value).replace(/\s+/g, ' ').trim();
    if (!trimmed) return null;
    let result = Object.prototype.hasOwnProperty.call(ZH, trimmed) ? ZH[trimmed] : null;
    if (result == null) for (const [pattern, replacement] of PATTERNS) if (pattern.test(trimmed)) { result = trimmed.replace(pattern, replacement); break; }
    if (result == null) return null;
    const lead = String(value).match(/^\s*/)[0], tail = String(value).match(/\s*$/)[0];
    return lead + result + tail;
  }
  const raw = node => { const element = node.nodeType === 1 ? node : node.parentElement; return !element || Boolean(element.closest('[data-raw],script,style,textarea')); };

  function visitText(node) {
    if (raw(node)) return;
    const next = translate(node.nodeValue);
    if (next != null && next !== node.nodeValue) { textOriginal.set(node, node.nodeValue); node.nodeValue = next; }
  }
  function visitElement(element) {
    if (raw(element)) return;
    for (const name of ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (!value) continue;
      const next = translate(value);
      if (next != null && next !== value) {
        const saved = attributeOriginal.get(element) || {};
        saved[name] = value; attributeOriginal.set(element, saved);
        element.setAttribute(name, next);
      }
    }
  }
  function walk(node, text, element) {
    if (node.nodeType === 3) { text(node); return; }
    if (node.nodeType !== 1) return;
    element(node);
    const walker = document.createTreeWalker(node, 5);
    for (let current = walker.nextNode(); current; current = walker.nextNode()) (current.nodeType === 3 ? text : element)(current);
  }
  function restore(node) {
    walk(node, textNode => { if (textOriginal.has(textNode)) { textNode.nodeValue = textOriginal.get(textNode); textOriginal.delete(textNode); } },
      element => { const saved = attributeOriginal.get(element); if (saved) { for (const name of Object.keys(saved)) element.setAttribute(name, saved[name]); attributeOriginal.delete(element); } });
  }

  function setLanguage(next) {
    next = next === 'zh' ? 'zh' : 'en';
    if (typeof document === 'undefined') { language = next; return; }
    if (observer) { observer.disconnect(); observer = null; }
    if (language === 'zh' && next !== 'zh') restore(document.documentElement);
    language = next;
    document.documentElement.lang = next === 'zh' ? 'zh-Hans' : 'en';
    if (next !== 'zh') return;
    walk(document.documentElement, visitText, visitElement);
    observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'characterData') visitText(record.target);
        else if (record.type === 'attributes') visitElement(record.target);
        else for (const added of record.addedNodes) walk(added, visitText, visitElement);
      }
    });
    observer.observe(document.documentElement, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES});
  }

  const api = {setLanguage, translate, get language() { return language; }, dictionary: ZH};
  root.WLSAI18n = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

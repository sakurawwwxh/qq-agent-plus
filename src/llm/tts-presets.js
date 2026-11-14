// TTS 服务预设（对标 asr 的服务预设）：OpenAI 兼容家族为主 + 每家的常用模型与音色表。
// 音色列表的来源与限制（2026-09-28 实测）：硅基流动没有 /v1/audio/voices 端点（404），
// OpenAI 也没有"列音色"的接口 —— 音色只能内置；模型名可点「获取模型列表」从官网拉全量。
export const TTS_SERVICES = [
  {
    id: 'siliconflow',
    label: '硅基流动（含 CosyVoice2，国内可直连）',
    provider: 'openai',
    creds: ['key'],
    baseUrl: 'https://api.siliconflow.cn/v1',
    hosts: ['api.siliconflow.cn'],
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    models: [
      { id: 'FunAudioLLM/CosyVoice2-0.5B', voices: ['anna', 'bella', 'claire', 'diana', 'benjamin', 'alex', 'charles', 'david'] },
      { id: 'fnlp/MOSS-TTSD-v0.5', voices: [] }
    ],
    note: '音色写法 = 模型id:音色（如 FunAudioLLM/CosyVoice2-0.5B:anna）。实测 speed（0.25~4）与 gain（-10~10dB）真实生效；模型列表可点「获取模型列表」从官网拉。'
  },
  {
    id: 'openai',
    label: 'OpenAI 官方（按量计费）',
    provider: 'openai',
    creds: ['key'],
    baseUrl: 'https://api.openai.com/v1',
    hosts: ['api.openai.com'],
    keyUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-4o-mini-tts', voices: ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'] },
      { id: 'tts-1', voices: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] }
    ],
    note: '国内多数网络直连不通，需要中转；音色与模型名来自 OpenAI 官方文档。'
  },
  {
    id: 'volc',
    label: '火山引擎 · 语音合成 v1（老接口，需 AppID + Access Token）',
    provider: 'volc',
    creds: ['appId', 'key'],
    baseUrl: 'https://openspeech.bytedance.com/api/v1/tts',
    hosts: ['openspeech.bytedance.com'],
    // 火山 v1 与豆包 v3 同域名，必须按路径区分（否则 v3 的地址会被认成 v1，请求打错接口）
    pathContains: '/api/v1/tts',
    keyUrl: 'https://console.volcengine.com/speech/app',
    cluster: 'volcano_tts',
    models: [],   // 火山 v1 接口不需要模型名（直接拼音色）
    voicesFlat: ['BV001_streaming', 'BV002_streaming', 'BV700_streaming', 'BV005_streaming', 'BV102_streaming'],
    note: '按官方文档实现。v1 要三样：AppID（应用管理里的一串数字）、Access Token（填「API Key」那一栏）、'
      + 'cluster 填 volcano_tts（**不要填音色名**）；音色写 voice_type（如 BV001_streaming 通用女声）。'
      + '复刻音色（S_ 开头）会自动改用 cluster=volcano_icl（适配器按音色切，不用手改）。'
      + '这是老接口，自然度不如下面的 2.0；账号没开通 v1 服务时会固定报 3001。'
  },
  {
    id: 'doubao',
    label: '火山引擎 · 豆包语音合成 2.0（音色最自然，推荐）',
    provider: 'doubao',
    creds: ['key'],
    baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
    hosts: ['openspeech.bytedance.com'],
    pathContains: '/api/v3/tts',
    keyUrl: 'https://console.volcengine.com/speech/app',
    resourceId: 'seed-tts-2.0',
    models: [],   // 这一家按「资源 ID + 音色」走，没有模型名
    // 音色表 = 火山官方 2.0 音色清单，按控制台分类排列（对着控制台看能一一对上）。
    // 2026-09-28 用真实账号把这 102 个逐个打过一遍：中文 99 个全部可用，
    // 只有 3 个英文音色返回空音频（账号未开通该资源）。音色属于哪个资源必须配套：
    // 1.0 音色（*_moon_bigtts / *_mars_bigtts）在 seed-tts-2.0 下会报 55000000 资源不匹配。
    voicesFlat: [
      // ── 通用场景 2.0（57 个，全部实测可用） ──
      { id: 'zh_female_vv_uranus_bigtts', label: 'Vivi 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_xiaohe_uranus_bigtts', label: '小何 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_m191_uranus_bigtts', label: '云舟 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_taocheng_uranus_bigtts', label: '小天 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_liufei_uranus_bigtts', label: '刘飞 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_sophie_uranus_bigtts', label: '魅力苏菲 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_qingxinnvsheng_uranus_bigtts', label: '清新女声 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_tianmeixiaoyuan_uranus_bigtts', label: '甜美小源 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_tianmeitaozi_uranus_bigtts', label: '甜美桃子 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_shuangkuaisisi_uranus_bigtts', label: '爽快思思 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_linjianvhai_uranus_bigtts', label: '邻家女孩 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_shaonianzixin_uranus_bigtts', label: '少年梓辛 / Brayan 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_meilinvyou_uranus_bigtts', label: '魅力女友 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_wenroumama_uranus_bigtts', label: '温柔妈妈 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_jieshuoxiaoming_uranus_bigtts', label: '解说小明 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_tvbnv_uranus_bigtts', label: 'TVB女声 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_yizhipiannan_uranus_bigtts', label: '译制片男 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_qiaopinv_uranus_bigtts', label: '俏皮女声 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_linjiananhai_uranus_bigtts', label: '邻家男孩 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_ruyaqingnian_uranus_bigtts', label: '儒雅青年 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_wennuanahu_uranus_bigtts', label: '温暖阿虎 / Alvin 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_naiqimengwa_uranus_bigtts', label: '奶气萌娃 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_popo_uranus_bigtts', label: '婆婆 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_gaolengyujie_uranus_bigtts', label: '高冷御姐 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_aojiaobazong_uranus_bigtts', label: '傲娇霸总 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_fanjuanqingnian_uranus_bigtts', label: '反卷青年 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_wenroushunv_uranus_bigtts', label: '温柔淑女 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_huolixiaoge_uranus_bigtts', label: '活力小哥 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_mengyatou_uranus_bigtts', label: '萌丫头 / Cutey 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_tiexinnvsheng_uranus_bigtts', label: '贴心女声 / Candy 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_jitangmei_uranus_bigtts', label: '鸡汤妹妹 / Hope 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_cixingjieshuonan_uranus_bigtts', label: '磁性解说男声 / Morgan 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_liangsangmengzai_uranus_bigtts', label: '亮嗓萌仔 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_kailangjiejie_uranus_bigtts', label: '开朗姐姐 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_gaolengchenwen_uranus_bigtts', label: '高冷沉稳 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_shenyeboke_uranus_bigtts', label: '深夜播客 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_jiaochuannv_uranus_bigtts', label: '娇喘女声 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_kailangdidi_uranus_bigtts', label: '开朗弟弟 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_chanmeinv_uranus_bigtts', label: '谄媚女声 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_qinqienv_uranus_bigtts', label: '亲切女声 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_kuailexiaodong_uranus_bigtts', label: '快乐小东 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_kailangxuezhang_uranus_bigtts', label: '开朗学长 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_youyoujunzi_uranus_bigtts', label: '悠悠君子 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_wenjingmaomao_uranus_bigtts', label: '文静毛毛 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_zhixingnv_uranus_bigtts', label: '知性女声 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_qingshuangnanda_uranus_bigtts', label: '清爽男大 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_yuanboxiaoshu_uranus_bigtts', label: '渊博小叔 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_yangguangqingnian_uranus_bigtts', label: '阳光青年 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_qingchezizi_uranus_bigtts', label: '清澈梓梓 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_tianmeiyueyue_uranus_bigtts', label: '甜美悦悦 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_xinlingjitang_uranus_bigtts', label: '心灵鸡汤 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_wenrouxiaoge_uranus_bigtts', label: '温柔小哥 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_roumeinvyou_uranus_bigtts', label: '柔美女友 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_dongfanghaoran_uranus_bigtts', label: '东方浩然 2.0', cat: '通用场景 2.0' },
      { id: 'zh_female_wenrouxiaoya_uranus_bigtts', label: '温柔小雅 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_tiancaitongsheng_uranus_bigtts', label: '天才童声 2.0', cat: '通用场景 2.0' },
      { id: 'zh_male_guanggaojieshuo_uranus_bigtts', label: '广告解说 2.0', cat: '通用场景 2.0' },
      // ── 角色扮演 2.0 ──
      { id: 'zh_female_cancan_uranus_bigtts', label: '知性灿灿 2.0', cat: '角色扮演 2.0' },
      { id: 'zh_female_sajiaoxuemei_uranus_bigtts', label: '撒娇学妹 2.0', cat: '角色扮演 2.0' },
      { id: 'zh_female_zhishuaiyingzi_uranus_bigtts', label: '直率英子 2.0', cat: '角色扮演 2.0' },
      { id: 'zh_male_silang_uranus_bigtts', label: '四郎 2.0', cat: '角色扮演 2.0' },
      { id: 'zh_male_qingcang_uranus_bigtts', label: '擎苍 2.0', cat: '角色扮演 2.0' },
      { id: 'zh_male_xionger_uranus_bigtts', label: '熊二 2.0', cat: '角色扮演 2.0' },
      { id: 'zh_female_yingtaowanzi_uranus_bigtts', label: '樱桃丸子 2.0', cat: '角色扮演 2.0' },
      { id: 'zh_male_lanyinmianbao_uranus_bigtts', label: '懒音绵宝 2.0', cat: '角色扮演 2.0' },
      { id: 'zh_female_gufengshaoyu_uranus_bigtts', label: '古风少御 2.0', cat: '角色扮演 2.0' },
      { id: 'zh_male_lubanqihao_uranus_bigtts', label: '鲁班七号 2.0', cat: '角色扮演 2.0' },
      { id: 'zh_female_linxiao_uranus_bigtts', label: '林潇 2.0', cat: '角色扮演 2.0' },
      { id: 'zh_female_lingling_uranus_bigtts', label: '玲玲姐姐 2.0', cat: '角色扮演 2.0' },
      { id: 'zh_female_chunribu_uranus_bigtts', label: '春日部姐姐 2.0', cat: '角色扮演 2.0' },
      { id: 'zh_male_tangseng_uranus_bigtts', label: '唐僧 2.0', cat: '角色扮演 2.0' },
      { id: 'zh_male_zhuangzhou_uranus_bigtts', label: '庄周 2.0', cat: '角色扮演 2.0' },
      { id: 'zh_male_zhubajie_uranus_bigtts', label: '猪八戒 2.0', cat: '角色扮演 2.0' },
      { id: 'zh_female_ganmaodianyin_uranus_bigtts', label: '感冒电音姐姐 2.0', cat: '角色扮演 2.0' },
      { id: 'zh_female_nvleishen_uranus_bigtts', label: '女雷神 2.0', cat: '角色扮演 2.0' },
      { id: 'zh_female_wuzetian_uranus_bigtts', label: '武则天 2.0', cat: '角色扮演 2.0' },
      { id: 'zh_female_gujie_uranus_bigtts', label: '顾姐 2.0', cat: '角色扮演 2.0' },
      { id: 'saturn_zh_female_tiaopigongzhu_tob', label: '调皮公主', cat: '角色扮演 2.0' },
      { id: 'saturn_zh_female_keainvsheng_tob', label: '可爱女生', cat: '角色扮演 2.0' },
      { id: 'saturn_zh_male_shuanglangshaonian_tob', label: '爽朗少年', cat: '角色扮演 2.0' },
      { id: 'saturn_zh_male_tiancaitongzhuo_tob', label: '天才同桌', cat: '角色扮演 2.0' },
      { id: 'saturn_zh_female_cancan_tob', label: '知性灿灿', cat: '角色扮演 2.0' },
      // ── 视频配音 2.0 ──
      { id: 'zh_female_peiqi_uranus_bigtts', label: '佩奇猪 2.0', cat: '视频配音 2.0' },
      { id: 'zh_male_sunwukong_uranus_bigtts', label: '猴哥 2.0', cat: '视频配音 2.0' },
      { id: 'zh_male_dayi_uranus_bigtts', label: '大壹 2.0', cat: '视频配音 2.0' },
      { id: 'zh_female_mizai_uranus_bigtts', label: '黑猫侦探社咪仔 2.0', cat: '视频配音 2.0' },
      { id: 'zh_female_jitangnv_uranus_bigtts', label: '鸡汤女 2.0', cat: '视频配音 2.0' },
      { id: 'zh_female_liuchangnv_uranus_bigtts', label: '流畅女声 2.0', cat: '视频配音 2.0' },
      { id: 'zh_male_ruyayichen_uranus_bigtts', label: '儒雅逸辰 2.0', cat: '视频配音 2.0' },
      // ── 有声阅读 2.0 ──
      { id: 'zh_female_xiaoxue_uranus_bigtts', label: '儿童绘本 2.0', cat: '有声阅读 2.0' },
      { id: 'zh_male_baqiqingshu_uranus_bigtts', label: '霸气青叔 2.0', cat: '有声阅读 2.0' },
      { id: 'zh_male_xuanyijieshuo_uranus_bigtts', label: '悬疑解说 2.0', cat: '有声阅读 2.0' },
      { id: 'zh_female_shaoergushi_uranus_bigtts', label: '少儿故事 2.0', cat: '有声阅读 2.0' },
      // ── 教育场景 2.0 ──
      { id: 'zh_female_yingyujiaoxue_uranus_bigtts', label: 'Tina老师 2.0', cat: '教育场景 2.0' },
      // ── 客服场景 2.0 ──
      { id: 'zh_female_kefunvsheng_uranus_bigtts', label: '暖阳女声 2.0', cat: '客服场景 2.0' },
      { id: 'saturn_zh_female_qingyingduoduo_cs_tob', label: '轻盈朵朵 2.0', cat: '客服场景 2.0' },
      { id: 'saturn_zh_female_wenwanshanshan_cs_tob', label: '温婉珊珊 2.0', cat: '客服场景 2.0' },
      { id: 'saturn_zh_female_reqingaina_cs_tob', label: '热情艾娜 2.0', cat: '客服场景 2.0' },
      { id: 'saturn_zh_male_qingxinmumu_cs_tob', label: '清新沐沐 2.0', cat: '客服场景 2.0' },
      // ── 多语种 2.0（3 个，需账号开通；未开通时报 resource not granted） ──
      { id: 'en_male_tim_uranus_bigtts', label: 'Tim（需账号开通多语种资源）', cat: '多语种 2.0' },
      { id: 'en_female_dacey_uranus_bigtts', label: 'Dacey（需账号开通多语种资源）', cat: '多语种 2.0' },
      { id: 'en_female_stokie_uranus_bigtts', label: 'Stokie（需账号开通多语种资源）', cat: '多语种 2.0' },
    ],
    note: '豆包大模型语音合成 2.0（/api/v3/tts/unidirectional，NDJSON 流式）。要填的只有两样：'
      + '「API Key」（语音技术控制台里的密钥，走 X-Api-Key 鉴权，**不需要 AppID / Cluster**）与「音色」。'
      + '资源 ID 默认 seed-tts-2.0，一般不用改（1.0 的音色要换 seed-tts-1.0）。'
      + '**声音复刻音色（S_ 开头）会自动改用 seed-icl-2.0**，但账号要先在控制台开通「声音复刻2.0字符版」'
      + '（后付费音色还要单独开通「后付费音色服务」），否则报 45000030 resource not granted。'
      + '音色表是官方 2.0 全量清单（102 个），实测中文 99 个都可用；不在表里的官方音色（如 ICL_uranus_*）'
      + '直接手填即可，它们与普通 2.0 音色同属 seed-tts-2.0，不需要改资源 ID。'
  },
  {
    id: 'minimax',
    label: 'MiniMax 语音（T2A v2，需 GroupId）',
    provider: 'minimax',
    creds: ['key', 'groupId'],
    baseUrl: 'https://api.minimax.chat',
    hosts: ['api.minimax.chat'],
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information',
    models: [
      { id: 'speech-01-turbo', voices: ['male-qn-qingse', 'female-shaonv', 'female-yujie', 'female-chengshu', 'presenter_male', 'presenter_female', 'audiobook_male_1', 'audiobook_female_1'] },
      { id: 'speech-02-hd', voices: ['male-qn-qingse', 'female-shaonv', 'female-yujie', 'presenter_male', 'presenter_female'] }
    ],
    note: '按官方文档实现、未实测：需要 API Key + GroupId；音频是 hex 编码（适配器已处理）。填好后点「试听」即可验证。'
  },
  {
    id: 'mimo',
    label: '小米 MiMo（token-plan，支持情绪/导演指令）',
    provider: 'mimo',
    creds: ['key'],
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    hosts: ['token-plan-cn.xiaomimimo.com'],
    // token-plan 控制台没有可用的固定公开链接：keyUrl 留空，界面不硬编一个可能失效的地址
    keyUrl: '',
    models: [
      {
        id: 'mimo-v2.5-tts',
        voices: [
          { id: 'mimo_default', label: '默认音色', cat: 'MiMo' },
          { id: '冰糖', label: '冰糖（甜、偏亮）', cat: 'MiMo' },
          { id: '茉莉', label: '茉莉（柔和）', cat: 'MiMo' },
          { id: '苏打', label: '苏打（清爽）', cat: 'MiMo' },
          { id: '白桦', label: '白桦（偏低沉）', cat: 'MiMo' },
          { id: 'Mia', label: 'Mia', cat: 'MiMo' },
          { id: 'Chloe', label: 'Chloe（清亮，实测近似小鲸鱼）', cat: 'MiMo' },
          { id: 'Milo', label: 'Milo', cat: 'MiMo' },
          { id: 'Dean', label: 'Dean', cat: 'MiMo' }
        ]
      }
    ],
    note: 'token-plan 的语音合成走 /v1/chat/completions：Key 放在 api-key 头，不是 Bearer。'
      + '「导演指令」可写角色/场景/语气（例如“你是小鲸鱼，声音软一点，像在群里随口聊天”）；'
      + 'send_voice 的 emotion 参数会自动追加一行情绪。实测有导演指令时停顿和语气更自然。'
      + '音色是内置候选，实际可用与否看账号开通情况；报错会带 HTTP 状态与上游原因。'
  },
  {
    id: 'custom',
    label: '自定义 / 自建（OpenAI 兼容 /audio/speech）',
    provider: 'openai',
    creds: ['key'],
    baseUrl: '',
    hosts: [],
    models: [],
    note: '任何 OpenAI 兼容的 /audio/speech：填地址 + 模型 + 音色即可。'
  }
];

export function ttsServiceById(id) {
  return TTS_SERVICES.find((s) => s.id === String(id || '').trim()) || null;
}

/**
 * 地址 → 服务。先按域名，同域名多家再按路径认（火山 v1 /api/v1/tts 与豆包 v3 /api/v3/tts
 * 是一个域名，不区分会把 v3 的地址认成 v1、请求打错接口）。路径缺失或认不出时按表序兜底
 * （老配置只写域名 = v1，保持原行为）。
 */
export function ttsServiceOfBaseUrl(url) {
  let host = '';
  let path = '';
  try {
    const u = new URL(String(url || '').trim());
    host = u.host.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch { return null; }
  const byHost = TTS_SERVICES.filter((s) => (s.hosts || []).includes(host));
  if (!byHost.length) return null;
  if (byHost.length === 1) return byHost[0];
  return byHost.find((s) => s.pathContains && path.includes(String(s.pathContains).toLowerCase()))
    || byHost.find((s) => !s.pathContains)
    || byHost[0];
}

/**
 * 当前配置对应哪家服务（地址决定实际打到谁家 → 优先按 baseUrl 认，其次 provider）。
 * openai 家族认不出地址（自建网关）时归到 `custom`：Key 按 keys['custom'] 存取。
 * 之前落表序第一家（siliconflow），会把硅基流动的 Key 发给用户自建的地址（2026-09-29 审查 P0）。
 */
export function ttsServiceOf(cfg) {
  const provider = String(cfg?.provider || '').trim().toLowerCase();
  const byUrl = ttsServiceOfBaseUrl(cfg?.baseUrl || '');
  if (byUrl) return byUrl;   // 同域名多家（火山 v1 / 豆包 v3）靠路径区分，见 ttsServiceOfBaseUrl
  if (provider === 'openai' || provider === 'custom') return ttsServiceById('custom') || TTS_SERVICES[TTS_SERVICES.length - 1];
  const byProvider = TTS_SERVICES.find((s) => s.provider === provider && s.id !== 'custom');
  return byProvider || ttsServiceById(provider) || TTS_SERVICES[TTS_SERVICES.length - 1];
}

/** 取某家（缺省"当前这家"）的 Key：keys 映射优先，回退旧的单 apiKey（兼容老配置）。 */
export function ttsKeyFor(cfg, serviceId = '') {
  const current = ttsServiceOf(cfg)?.id || '';
  const id = serviceId || current;
  // 用**自有属性**读映射：serviceId 来自端点查询串（外部可控），`keys['constructor']` 会命中原型链，
  // 把函数源码当成"这家存过的 Key"（与 config-legacy 的 imageGenKeyFor 同款，2026-10-03 全量审查）
  const map = cfg?.keys;
  const fromMap = map && typeof map === 'object' && Object.hasOwn(map, id) ? String(map[id] || '').trim() : '';
  if (fromMap) return fromMap;
  // 旧配置只有一个 apiKey（没有 keys 映射）：**归属明确**（apiKeyService = 这把是给哪家存的，
  // 提交时记）才用。没记归属的老配置按"当前这家"兜底 —— **升级不改变任何人在用/不在用**。
  // ⚠️ 为什么不能继续只看"是不是当前这家"（2026-09-28 起一直是这么兜底的）：切换服务预设后
  // current 会跟着变，上一家那把单槽 Key 就被当成新服务的那把发出去 —— 与 asr 侧 2026-09-26
  // 修过的事故同型（把腾讯的 SecretKey 当讯飞 APISecret 发出去）。
  const owner = String(cfg?.apiKeyService || '').trim() || current;
  return id === owner ? String(cfg?.apiKey || '').trim() : '';
}

/** 哪几家已经存过 Key（给界面显示掩码用；不下发明文）。 */
export function ttsKeyServices(cfg) {
  const ids = Object.entries(cfg?.keys || {}).filter(([, v]) => String(v || '').trim()).map(([k]) => k);
  if (!ids.length && String(cfg?.apiKey || '').trim()) {
    const svc = ttsServiceOf(cfg);
    if (svc) ids.push(svc.id);
  }
  return ids;
}

export function ttsModelsFor(serviceId) {
  return ttsServiceById(serviceId)?.models || [];
}

/** 音色条目统一成 { id, label, cat }：内置表三种写法都吃（字符串 / 带中文名 / 带分类）。 */
function normVoice(v) {
  if (typeof v === 'string') {
    const id = v.trim();
    return id ? { id, label: id, cat: '' } : null;
  }
  const id = String(v?.id || '').trim();
  return id ? { id, label: String(v?.label || id).trim(), cat: String(v?.cat || '').trim() } : null;
}

/** 某家（可指定模型）的候选音色：模型自带音色优先，否则用服务级音色表（火山/豆包这类）。 */
export function ttsVoiceOptions(serviceId, model = '') {
  const svc = ttsServiceById(serviceId);
  if (!svc) return [];
  const byModel = (svc.models || []).find((m) => m.id === String(model || '').trim())?.voices || [];
  const list = byModel.length ? byModel : (svc.voicesFlat || []);
  return list.map(normVoice).filter(Boolean);
}

/** 兼容旧调用：只返回 id 列表。 */
export function ttsVoicesFor(serviceId, model) {
  return ttsVoiceOptions(serviceId, model).map((v) => v.id);
}


/** Custom endpoints cannot share an unqualified "custom" voice slot. */
export function ttsVoiceSlot(baseUrl, model = '') {
  return JSON.stringify([String(baseUrl || '').trim().replace(/\/+$/, ''), String(model || '').trim()]);
}

#!/usr/bin/env python3
"""用浏览器登录态把一篇 markdown/纯文本发成 B 站图文（默认只存草稿）。

为什么不用 API：/x/dynamic/feed/article/draft/add 直连会被风控挡（code=-111 CSRF 校验失败，
即使带上完整 cookie 集与 csrf 参数）；走真实浏览器会话才通。见 README「投稿通道」。

用法:
    publish_article.py <正文文件> --title "标题" [--cover 封面.png] [--publish]
    publish_article.py --selftest          # 只打开编辑器，不发

默认动作 = 存草稿。要真发布必须显式加 --publish。
依赖：~/DeepSeek/Browser/.venv 里的 playwright + 已装 chromium。
"""
import argparse, json, sys, time

import os
_DSH_HOME = os.environ.get('DSH_HOME') or os.path.expanduser('~/.dsh')
CREDS = os.path.join(_DSH_HOME, 'mira_config', 'mira_account', 'creds', 'bili-mira.json')
EDITOR = 'https://member.bilibili.com/york/read-editor'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'


def markdown_to_plain(text):
    """去掉 markdown 标记，只留文字行（B 站编辑器是富文本，这里按行注入纯文本）。"""
    out = []
    for line in text.splitlines():
        s = line.rstrip()
        if s.startswith('```'):
            continue
        s = s.lstrip('#').strip() if s.startswith('#') else s
        s = s.replace('**', '').replace('`', '')
        if s.startswith('> '):
            s = s[2:].strip()
        out.append(s)
    # 压掉连续空行
    res, blank = [], 0
    for s in out:
        if not s:
            blank += 1
            if blank > 1:
                continue
        else:
            blank = 0
        res.append(s)
    return '\n'.join(res).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('file', nargs='?')
    ap.add_argument('--title', default='')
    ap.add_argument('--cover', default='')
    ap.add_argument('--publish', action='store_true', help='真发布；不加则只存草稿')
    ap.add_argument('--selftest', action='store_true')
    ap.add_argument('--timeout', type=float, default=30)
    a = ap.parse_args()

    from playwright.sync_api import sync_playwright

    fields = json.load(open(CREDS))['fields']
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(user_agent=UA, viewport={'width': 1440, 'height': 900})
        ctx.add_cookies([{'name': k, 'value': v, 'domain': '.bilibili.com', 'path': '/'}
                         for k, v in fields.items() if k != 'DedeUserID__ckMd5'])
        page = ctx.new_page()
        page.goto(EDITOR, wait_until='domcontentloaded', timeout=60000)
        time.sleep(12)

        if a.selftest:
            print('title:', page.title())
            print('buttons:', page.evaluate("() => Array.from(document.querySelectorAll('button,.btn,[role=button]')).map(e=>(e.innerText||'').trim()).filter(Boolean).slice(0,8)"))
            b.close(); return 0

        if not a.file:
            print('missing file', file=sys.stderr); b.close(); return 2
        title = a.title or open(a.file, encoding='utf-8').readline().lstrip('#').strip()[:50]
        body = markdown_to_plain(open(a.file, encoding='utf-8').read())

        page.fill('textarea.title-input__inner', title)
        page.click('.tiptap.ProseMirror')
        page.keyboard.insert_text(body)      # insert_text 保留换行，不触发快捷键
        time.sleep(1.5)
        if a.cover:
            try:
                page.set_input_files('input[type=file]', a.cover)
                time.sleep(3)
                print('cover uploaded')
            except Exception as e:
                print('cover failed:', str(e)[:120])
        page.on('dialog', lambda d: d.accept())
        btn = '发布' if a.publish else '保存为草稿'
        if a.publish:
            # 原创声明勾选（未勾时点发布会静默失败）
            try:
                for sel in ('text=声明此文章为原创', 'text=创作声明'):
                    el = page.query_selector(sel)
                    if el:
                        el.click(timeout=3000)
                        time.sleep(0.5)
                        break
            except Exception:
                pass
        page.click(f'text={btn}', timeout=15000)
        time.sleep(6)
        if a.publish:
            # 发布设置面板展开后再点一次底部的「发布」：用 JS 取最靠下的那个（按钮常是 div 不是 button）
            try:
                time.sleep(2)
                r = page.evaluate("""() => {
                  const els=[...document.querySelectorAll('button,div,span,a')]
                    .filter(e=>(e.textContent||'').trim()==='发布');
                  if(!els.length) return 'none';
                  els.sort((a,b)=>b.getBoundingClientRect().top-a.getBoundingClientRect().top);
                  const el=els[0];
                  el.scrollIntoView({block:'center'});
                  el.click();
                  return 'clicked ' + els.length + ' @top=' + Math.round(el.getBoundingClientRect().top);
                }""")
                print('panel publish click:', r)
                time.sleep(8)
            except Exception as e:
                print('second click skipped:', str(e)[:80])
            # 真实验证：等「提交成功」toast / 编辑器关闭；拿不到就明确报失败（旧版这里直接报 PUBLISHED，撒谎）
            ok = False
            for _ in range(25):
                time.sleep(1)
                try:
                    body = page.evaluate("() => document.body.innerText")
                except Exception:
                    body = ''
                if '提交成功' in body or '已提交' in body:
                    ok = True; print('toast: 提交成功'); break
                if ('read-editor' not in page.url) and ('发布设置' not in body):
                    ok = True; print('editor closed / left page'); break
            if not ok:
                print('发布未确认：仍停在发布设置（截图留证）')
            print('after publish url:', page.url)
            print('body tail:', page.evaluate("() => document.body.innerText.slice(-300)"))
            publish_confirmed = ok
        time.sleep(4)
        try:
            print('page url after:', page.url)
            for f in page.frames:
                if 'read-editor' in f.url:
                    print('editor frame url:', f.url[:200])
        except Exception:
            pass
        page.screenshot(path='/tmp/bili_publish_result.png')
        if a.publish:
            print(('PUBLISHED' if publish_confirmed else 'PUBLISH UNCONFIRMED') + ' | title: ' + title)
        else:
            print('DRAFT SAVED | title: ' + title)
        print('shot: /tmp/bili_publish_result.png')
        b.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())

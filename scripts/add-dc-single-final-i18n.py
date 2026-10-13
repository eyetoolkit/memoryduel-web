import json, io

T = {
    'en': {
        'final_title_single': '{game} complete',
        'final_perfect_single': 'Perfect!',
    },
    'zh': {
        'final_title_single': '「{game}」完成',
        'final_perfect_single': '满分通关！',
    },
    'ja': {
        'final_title_single': '「{game}」クリア',
        'final_perfect_single': 'パーフェクト！',
    },
    'es': {
        'final_title_single': '{game} completado',
        'final_perfect_single': '¡Perfecto!',
    },
    'fr': {
        'final_title_single': '{game} terminé',
        'final_perfect_single': 'Parfait !',
    },
    'de': {
        'final_title_single': '{game} abgeschlossen',
        'final_perfect_single': 'Perfekt!',
    },
}

for l, keys in T.items():
    p = 'public/i18n/%s.json' % l
    with io.open(p, 'r', encoding='utf-8') as f:
        d = json.load(f)
    changed = 0
    for k, v in keys.items():
        if d['dc'].get(k) == v:
            continue
        d['dc'][k] = v
        changed += 1
    with io.open(p, 'w', encoding='utf-8', newline='\n') as f:
        f.write(json.dumps(d, ensure_ascii=False, indent=2) + '\n')
    print(l, '写入', changed, '个键')

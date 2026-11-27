# Checks every GSClass.Method(...) call in main.nut against OpenTTD script API headers:
# method exists, arg count fits, constants exist. Instance methods (on event/list objects) are not checked.
# Run it against both the 14.x and the 15.x headers (info.nut declares API 14).
# Usage: python3 -I tools/check_gs_api.py <dir with script_*.hpp> gamescript/AgentBridge/main.nut
# Headers: gh api "repos/OpenTTD/OpenTTD/git/trees/15.3?recursive=1" --jq ".tree[].path" | grep "^src/script/api/script_.*\.hpp$"
#   then fetch each with: gh api "repos/OpenTTD/OpenTTD/contents/<path>?ref=15.3" -H "Accept: application/vnd.github.raw"
import re,sys,glob,os
api={}   # (Class, Method) -> set of arg counts ; also constants
consts={}
for f in glob.glob(sys.argv[1]+'/*.hpp'):
    t=open(f).read()
    # strip comments
    t=re.sub(r'/\*.*?\*/','',t,flags=re.S); t=re.sub(r'//[^\n]*','',t)
    for cm in re.finditer(r'class\s+Script(\w+)\s*(?::\s*public\s+Script(\w+))?\s*\{',t):
        cls=cm.group(1); start=cm.end(); depth=1; i=start
        while depth and i<len(t):
            depth+= t[i]=='{'; depth-= t[i]=='}'; i+=1
        body=t[start:i]
        base=cm.group(2)
        api.setdefault(cls,{'m':{},'c':set(),'base':base})
        for m in re.finditer(r'static\s+[\w:<>,\s\*&]+?[\s\*&](\w+)\s*\(([^)]*)\)',body):
            ps=[p for p in m.group(2).split(',') if p.strip() and p.strip()!='void']
            req=len([p for p in ps if '=' not in p])
            api[cls]['m'].setdefault(m.group(1),set()).update(range(req,len(ps)+1))
        for m in re.finditer(r'\b([A-Z][A-Z0-9_]+)\s*(=|,|\n|\})',body):
            api[cls]['c'].add(m.group(1))
def lookup(cls,kind,name):
    while cls in api:
        d=api[cls]['m' if kind=='m' else 'c']
        if name in d: return d[name] if kind=="m" else True
        cls=api[cls]['base']
    return None
src=open(sys.argv[2]).read()
# Lines marked "gs-api-compat" call an API of another OpenTTD version on purpose (behind a run-time check).
compat_lines={i+1 for i,l in enumerate(src.split('\n')) if 'gs-api-compat' in l}
src_nc=re.sub(r'//[^\n]*','',src)
def count_args(s,i):
    depth=1;n=0;j=i;nonempty=False;instr=False
    while j<len(s) and depth:
        ch=s[j]
        if instr:
            if ch=='\\': j+=1
            elif ch=='"': instr=False
        elif ch=='"': instr=True; nonempty=True
        elif ch in '([{': depth+=1; nonempty=True
        elif ch in ')]}': depth-=1
        elif ch==',' and depth==1: n+=1
        elif not ch.isspace(): nonempty=True
        j+=1
    return n+1 if nonempty else 0
probs=0
for m in re.finditer(r'\bGS(\w+)\.(\w+)\b(\s*\()?',src_nc):
    cls,name,call=m.groups()
    line=src_nc[:m.start()].count('\n')+1
    if line in compat_lines: continue
    if cls not in api: print(f'L{line}: unknown class GS{cls}'); probs+=1; continue
    if call:
        arities=lookup(cls,'m',name)
        if arities is None: print(f'L{line}: GS{cls}.{name} not a static method'); probs+=1; continue
        n=count_args(src_nc,m.end())
        if n not in arities: print(f'L{line}: GS{cls}.{name} called with {n} args, expects {sorted(arities)}'); probs+=1
    else:
        if lookup(cls,'c',name) is None and lookup(cls,'m',name) is None:
            print(f'L{line}: GS{cls}.{name} unknown constant'); probs+=1
print('problems:',probs)

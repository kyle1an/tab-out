var wt,R,Fn,Re,fn,On,zt,Nn,nn,jt,Vt,tt={},Wn=[],wo=/acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i,on=Array.isArray;function Ie(e,t){for(var n in t)e[n]=t[n];return e}function sn(e){e&&e.parentNode&&e.parentNode.removeChild(e)}function ie(e,t,n){var o,r,s,i={};for(s in t)s=="key"?o=t[s]:s=="ref"?r=t[s]:i[s]=t[s];if(arguments.length>2&&(i.children=arguments.length>3?wt.call(arguments,2):n),typeof e=="function"&&e.defaultProps!=null)for(s in e.defaultProps)i[s]===void 0&&(i[s]=e.defaultProps[s]);return it(e,i,o,r,null)}function it(e,t,n,o,r){var s={type:e,props:t,key:n,ref:o,__k:null,__:null,__b:0,__e:null,__c:null,constructor:void 0,__v:r??++Fn,__i:-1,__u:0};return r==null&&R.vnode!=null&&R.vnode(s),s}function ye(e){return e.children}function at(e,t){this.props=e,this.context=t}function Be(e,t){if(t==null)return e.__?Be(e.__,e.__i+1):null;for(var n;t<e.__k.length;t++)if((n=e.__k[t])!=null&&n.__e!=null)return n.__e;return typeof e.type=="function"?Be(e):null}function Gn(e){var t,n;if((e=e.__)!=null&&e.__c!=null){for(e.__e=e.__c.base=null,t=0;t<e.__k.length;t++)if((n=e.__k[t])!=null&&n.__e!=null){e.__e=e.__c.base=n.__e;break}return Gn(e)}}function pn(e){(!e.__d&&(e.__d=!0)&&Re.push(e)&&!ht.__r++||fn!==R.debounceRendering)&&((fn=R.debounceRendering)||On)(ht)}function ht(){var e,t,n,o,r,s,i,a;for(Re.sort(zt);e=Re.shift();)e.__d&&(t=Re.length,o=void 0,s=(r=(n=e).__v).__e,i=[],a=[],n.__P&&((o=Ie({},r)).__v=r.__v+1,R.vnode&&R.vnode(o),rn(n.__P,o,r,n.__n,n.__P.namespaceURI,32&r.__u?[s]:null,i,s??Be(r),!!(32&r.__u),a),o.__v=r.__v,o.__.__k[o.__i]=o,jn(i,o,a),o.__e!=s&&Gn(o)),Re.length>t&&Re.sort(zt));ht.__r=0}function Bn(e,t,n,o,r,s,i,a,u,d,h){var l,p,c,f,_,b,g=o&&o.__k||Wn,y=t.length;for(u=vo(n,t,g,u),l=0;l<y;l++)(c=n.__k[l])!=null&&(p=c.__i===-1?tt:g[c.__i]||tt,c.__i=l,b=rn(e,c,p,r,s,i,a,u,d,h),f=c.__e,c.ref&&p.ref!=c.ref&&(p.ref&&an(p.ref,null,c),h.push(c.ref,c.__c||f,c)),_==null&&f!=null&&(_=f),4&c.__u||p.__k===c.__k?u=zn(c,u,e):typeof c.type=="function"&&b!==void 0?u=b:f&&(u=f.nextSibling),c.__u&=-7);return n.__e=_,u}function vo(e,t,n,o){var r,s,i,a,u,d=t.length,h=n.length,l=h,p=0;for(e.__k=[],r=0;r<d;r++)(s=t[r])!=null&&typeof s!="boolean"&&typeof s!="function"?(a=r+p,(s=e.__k[r]=typeof s=="string"||typeof s=="number"||typeof s=="bigint"||s.constructor==String?it(null,s,null,null,null):on(s)?it(ye,{children:s},null,null,null):s.constructor===void 0&&s.__b>0?it(s.type,s.props,s.key,s.ref?s.ref:null,s.__v):s).__=e,s.__b=e.__b+1,i=null,(u=s.__i=yo(s,n,a,l))!==-1&&(l--,(i=n[u])&&(i.__u|=2)),i==null||i.__v===null?(u==-1&&p--,typeof s.type!="function"&&(s.__u|=4)):u!==a&&(u==a-1?p--:u==a+1?p++:(u>a?p--:p++,s.__u|=4))):s=e.__k[r]=null;if(l)for(r=0;r<h;r++)(i=n[r])!=null&&(2&i.__u)==0&&(i.__e==o&&(o=Be(i)),Vn(i,i));return o}function zn(e,t,n){var o,r;if(typeof e.type=="function"){for(o=e.__k,r=0;o&&r<o.length;r++)o[r]&&(o[r].__=e,t=zn(o[r],t,n));return t}e.__e!=t&&(t&&e.type&&!n.contains(t)&&(t=Be(e)),n.insertBefore(e.__e,t||null),t=e.__e);do t=t&&t.nextSibling;while(t!=null&&t.nodeType===8);return t}function yo(e,t,n,o){var r=e.key,s=e.type,i=n-1,a=n+1,u=t[n];if(u===null||u&&r==u.key&&s===u.type&&(2&u.__u)==0)return n;if((typeof s!="function"||s===ye||r)&&o>(u!=null&&(2&u.__u)==0?1:0))for(;i>=0||a<t.length;){if(i>=0){if((u=t[i])&&(2&u.__u)==0&&r==u.key&&s===u.type)return i;i--}if(a<t.length){if((u=t[a])&&(2&u.__u)==0&&r==u.key&&s===u.type)return a;a++}}return-1}function hn(e,t,n){t[0]==="-"?e.setProperty(t,n??""):e[t]=n==null?"":typeof n!="number"||wo.test(t)?n:n+"px"}function nt(e,t,n,o,r){var s;e:if(t==="style")if(typeof n=="string")e.style.cssText=n;else{if(typeof o=="string"&&(e.style.cssText=o=""),o)for(t in o)n&&t in n||hn(e.style,t,"");if(n)for(t in n)o&&n[t]===o[t]||hn(e.style,t,n[t])}else if(t[0]==="o"&&t[1]==="n")s=t!==(t=t.replace(Nn,"$1")),t=t.toLowerCase()in e||t==="onFocusOut"||t==="onFocusIn"?t.toLowerCase().slice(2):t.slice(2),e.l||(e.l={}),e.l[t+s]=n,n?o?n.u=o.u:(n.u=nn,e.addEventListener(t,s?Vt:jt,s)):e.removeEventListener(t,s?Vt:jt,s);else{if(r=="http://www.w3.org/2000/svg")t=t.replace(/xlink(H|:h)/,"h").replace(/sName$/,"s");else if(t!="width"&&t!="height"&&t!="href"&&t!="list"&&t!="form"&&t!="tabIndex"&&t!="download"&&t!="rowSpan"&&t!="colSpan"&&t!="role"&&t!="popover"&&t in e)try{e[t]=n??"";break e}catch{}typeof n=="function"||(n==null||n===!1&&t[4]!=="-"?e.removeAttribute(t):e.setAttribute(t,t=="popover"&&n==1?"":n))}}function mn(e){return function(t){if(this.l){var n=this.l[t.type+e];if(t.t==null)t.t=nn++;else if(t.t<n.u)return;return n(R.event?R.event(t):t)}}}function rn(e,t,n,o,r,s,i,a,u,d){var h,l,p,c,f,_,b,g,y,L,K,te,F,ne,ae,V,D,G=t.type;if(t.constructor!==void 0)return null;128&n.__u&&(u=!!(32&n.__u),s=[a=t.__e=n.__e]),(h=R.__b)&&h(t);e:if(typeof G=="function")try{if(g=t.props,y="prototype"in G&&G.prototype.render,L=(h=G.contextType)&&o[h.__c],K=h?L?L.props.value:h.__:o,n.__c?b=(l=t.__c=n.__c).__=l.__E:(y?t.__c=l=new G(g,K):(t.__c=l=new at(g,K),l.constructor=G,l.render=Co),L&&L.sub(l),l.props=g,l.state||(l.state={}),l.context=K,l.__n=o,p=l.__d=!0,l.__h=[],l._sb=[]),y&&l.__s==null&&(l.__s=l.state),y&&G.getDerivedStateFromProps!=null&&(l.__s==l.state&&(l.__s=Ie({},l.__s)),Ie(l.__s,G.getDerivedStateFromProps(g,l.__s))),c=l.props,f=l.state,l.__v=t,p)y&&G.getDerivedStateFromProps==null&&l.componentWillMount!=null&&l.componentWillMount(),y&&l.componentDidMount!=null&&l.__h.push(l.componentDidMount);else{if(y&&G.getDerivedStateFromProps==null&&g!==c&&l.componentWillReceiveProps!=null&&l.componentWillReceiveProps(g,K),!l.__e&&(l.shouldComponentUpdate!=null&&l.shouldComponentUpdate(g,l.__s,K)===!1||t.__v===n.__v)){for(t.__v!==n.__v&&(l.props=g,l.state=l.__s,l.__d=!1),t.__e=n.__e,t.__k=n.__k,t.__k.some(function(Y){Y&&(Y.__=t)}),te=0;te<l._sb.length;te++)l.__h.push(l._sb[te]);l._sb=[],l.__h.length&&i.push(l);break e}l.componentWillUpdate!=null&&l.componentWillUpdate(g,l.__s,K),y&&l.componentDidUpdate!=null&&l.__h.push(function(){l.componentDidUpdate(c,f,_)})}if(l.context=K,l.props=g,l.__P=e,l.__e=!1,F=R.__r,ne=0,y){for(l.state=l.__s,l.__d=!1,F&&F(t),h=l.render(l.props,l.state,l.context),ae=0;ae<l._sb.length;ae++)l.__h.push(l._sb[ae]);l._sb=[]}else do l.__d=!1,F&&F(t),h=l.render(l.props,l.state,l.context),l.state=l.__s;while(l.__d&&++ne<25);l.state=l.__s,l.getChildContext!=null&&(o=Ie(Ie({},o),l.getChildContext())),y&&!p&&l.getSnapshotBeforeUpdate!=null&&(_=l.getSnapshotBeforeUpdate(c,f)),a=Bn(e,on(V=h!=null&&h.type===ye&&h.key==null?h.props.children:h)?V:[V],t,n,o,r,s,i,a,u,d),l.base=t.__e,t.__u&=-161,l.__h.length&&i.push(l),b&&(l.__E=l.__=null)}catch(Y){if(t.__v=null,u||s!=null)if(Y.then){for(t.__u|=u?160:128;a&&a.nodeType===8&&a.nextSibling;)a=a.nextSibling;s[s.indexOf(a)]=null,t.__e=a}else for(D=s.length;D--;)sn(s[D]);else t.__e=n.__e,t.__k=n.__k;R.__e(Y,t,n)}else s==null&&t.__v===n.__v?(t.__k=n.__k,t.__e=n.__e):a=t.__e=$o(n.__e,t,n,o,r,s,i,u,d);return(h=R.diffed)&&h(t),128&t.__u?void 0:a}function jn(e,t,n){for(var o=0;o<n.length;o++)an(n[o],n[++o],n[++o]);R.__c&&R.__c(t,e),e.some(function(r){try{e=r.__h,r.__h=[],e.some(function(s){s.call(r)})}catch(s){R.__e(s,r.__v)}})}function $o(e,t,n,o,r,s,i,a,u){var d,h,l,p,c,f,_,b=n.props,g=t.props,y=t.type;if(y==="svg"?r="http://www.w3.org/2000/svg":y==="math"?r="http://www.w3.org/1998/Math/MathML":r||(r="http://www.w3.org/1999/xhtml"),s!=null){for(d=0;d<s.length;d++)if((c=s[d])&&"setAttribute"in c==!!y&&(y?c.localName===y:c.nodeType===3)){e=c,s[d]=null;break}}if(e==null){if(y===null)return document.createTextNode(g);e=document.createElementNS(r,y,g.is&&g),a&&(R.__m&&R.__m(t,s),a=!1),s=null}if(y===null)b===g||a&&e.data===g||(e.data=g);else{if(s=s&&wt.call(e.childNodes),b=n.props||tt,!a&&s!=null)for(b={},d=0;d<e.attributes.length;d++)b[(c=e.attributes[d]).name]=c.value;for(d in b)if(c=b[d],d!="children"){if(d=="dangerouslySetInnerHTML")l=c;else if(!(d in g)){if(d=="value"&&"defaultValue"in g||d=="checked"&&"defaultChecked"in g)continue;nt(e,d,null,c,r)}}for(d in g)c=g[d],d=="children"?p=c:d=="dangerouslySetInnerHTML"?h=c:d=="value"?f=c:d=="checked"?_=c:a&&typeof c!="function"||b[d]===c||nt(e,d,c,b[d],r);if(h)a||l&&(h.__html===l.__html||h.__html===e.innerHTML)||(e.innerHTML=h.__html),t.__k=[];else if(l&&(e.innerHTML=""),Bn(e,on(p)?p:[p],t,n,o,y==="foreignObject"?"http://www.w3.org/1999/xhtml":r,s,i,s?s[0]:n.__k&&Be(n,0),a,u),s!=null)for(d=s.length;d--;)sn(s[d]);a||(d="value",y==="progress"&&f==null?e.removeAttribute("value"):f!==void 0&&(f!==e[d]||y==="progress"&&!f||y==="option"&&f!==b[d])&&nt(e,d,f,b[d],r),d="checked",_!==void 0&&_!==e[d]&&nt(e,d,_,b[d],r))}return e}function an(e,t,n){try{if(typeof e=="function"){var o=typeof e.__u=="function";o&&e.__u(),o&&t==null||(e.__u=e(t))}else e.current=t}catch(r){R.__e(r,n)}}function Vn(e,t,n){var o,r;if(R.unmount&&R.unmount(e),(o=e.ref)&&(o.current&&o.current!==e.__e||an(o,null,t)),(o=e.__c)!=null){if(o.componentWillUnmount)try{o.componentWillUnmount()}catch(s){R.__e(s,t)}o.base=o.__P=null}if(o=e.__k)for(r=0;r<o.length;r++)o[r]&&Vn(o[r],t,n||typeof e.type!="function");n||sn(e.__e),e.__c=e.__=e.__e=void 0}function Co(e,t,n){return this.constructor(e,n)}function qn(e,t,n){var o,r,s,i;t===document&&(t=document.documentElement),R.__&&R.__(e,t),r=(o=!1)?null:t.__k,s=[],i=[],rn(t,e=t.__k=ie(ye,null,[e]),r||tt,tt,t.namespaceURI,r?null:t.firstChild?wt.call(t.childNodes):null,s,r?r.__e:t.firstChild,o,i),jn(s,e,i)}wt=Wn.slice,R={__e:function(e,t,n,o){for(var r,s,i;t=t.__;)if((r=t.__c)&&!r.__)try{if((s=r.constructor)&&s.getDerivedStateFromError!=null&&(r.setState(s.getDerivedStateFromError(e)),i=r.__d),r.componentDidCatch!=null&&(r.componentDidCatch(e,o||{}),i=r.__d),i)return r.__E=r}catch(a){e=a}throw e}},Fn=0,at.prototype.setState=function(e,t){var n;n=this.__s!=null&&this.__s!==this.state?this.__s:this.__s=Ie({},this.state),typeof e=="function"&&(e=e(Ie({},n),this.props)),e&&Ie(n,e),e!=null&&this.__v&&(t&&this._sb.push(t),pn(this))},at.prototype.forceUpdate=function(e){this.__v&&(this.__e=!0,e&&this.__h.push(e),pn(this))},at.prototype.render=ye,Re=[],On=typeof Promise=="function"?Promise.prototype.then.bind(Promise.resolve()):setTimeout,zt=function(e,t){return e.__v.__b-t.__v.__b},ht.__r=0,Nn=/(PointerCapture)$|Capture$/i,nn=0,jt=mn(!1),Vt=mn(!0);var Kn=function(e,t,n,o){var r;t[0]=0;for(var s=1;s<t.length;s++){var i=t[s++],a=t[s]?(t[0]|=i?1:2,n[t[s++]]):t[++s];i===3?o[0]=a:i===4?o[1]=Object.assign(o[1]||{},a):i===5?(o[1]=o[1]||{})[t[++s]]=a:i===6?o[1][t[++s]]+=a+"":i?(r=e.apply(a,Kn(e,a,n,["",null])),o.push(r),a[0]?t[0]|=2:(t[s-2]=0,t[s]=r)):o.push(a)}return o},_n=new Map;function ce(e){var t=_n.get(this);return t||(t=new Map,_n.set(this,t)),(t=Kn(this,t.get(e)||(t.set(e,t=(function(n){for(var o,r,s=1,i="",a="",u=[0],d=function(p){s===1&&(p||(i=i.replace(/^\s*\n\s*|\s*\n\s*$/g,"")))?u.push(0,p,i):s===3&&(p||i)?(u.push(3,p,i),s=2):s===2&&i==="..."&&p?u.push(4,p,0):s===2&&i&&!p?u.push(5,0,!0,i):s>=5&&((i||!p&&s===5)&&(u.push(s,0,i,r),s=6),p&&(u.push(s,p,0,r),s=6)),i=""},h=0;h<n.length;h++){h&&(s===1&&d(),d(h));for(var l=0;l<n[h].length;l++)o=n[h][l],s===1?o==="<"?(d(),u=[u],s=3):i+=o:s===4?i==="--"&&o===">"?(s=1,i=""):i=o+i[0]:a?o===a?a="":i+=o:o==='"'||o==="'"?a=o:o===">"?(d(),s=1):s&&(o==="="?(s=5,r=i,i=""):o==="/"&&(s<5||n[h][l+1]===">")?(d(),s===3&&(u=u[0]),s=u,(u=u[0]).push(2,0,s),s=0):o===" "||o==="	"||o===`
`||o==="\r"?(d(),s=2):i+=o),s===3&&i==="!--"&&(s=4,u=u[0])}return d(),u})(e)),t),arguments,[])).length>1?t:t[0]}var ze,A,Mt,bn,mt=0,Yn=[],H=R,gn=H.__b,wn=H.__r,vn=H.diffed,yn=H.__c,$n=H.unmount,Cn=H.__;function vt(e,t){H.__h&&H.__h(A,e,mt||t),mt=0;var n=A.__H||(A.__H={__:[],__h:[]});return e>=n.__.length&&n.__.push({}),n.__[e]}function J(e){return mt=1,ko(Zn,e)}function ko(e,t,n){var o=vt(ze++,2);if(o.t=e,!o.__c&&(o.__=[Zn(void 0,t),function(a){var u=o.__N?o.__N[0]:o.__[0],d=o.t(u,a);u!==d&&(o.__N=[d,o.__[1]],o.__c.setState({}))}],o.__c=A,!A.u)){var r=function(a,u,d){if(!o.__c.__H)return!0;var h=o.__c.__H.__.filter(function(p){return!!p.__c});if(h.every(function(p){return!p.__N}))return!s||s.call(this,a,u,d);var l=o.__c.props!==a;return h.forEach(function(p){if(p.__N){var c=p.__[0];p.__=p.__N,p.__N=void 0,c!==p.__[0]&&(l=!0)}}),s&&s.call(this,a,u,d)||l};A.u=!0;var s=A.shouldComponentUpdate,i=A.componentWillUpdate;A.componentWillUpdate=function(a,u,d){if(this.__e){var h=s;s=void 0,r(a,u,d),s=h}i&&i.call(this,a,u,d)},A.shouldComponentUpdate=r}return o.__N||o.__}function z(e,t){var n=vt(ze++,3);!H.__s&&cn(n.__H,t)&&(n.__=e,n.i=t,A.__H.__h.push(n))}function ln(e,t){var n=vt(ze++,4);!H.__s&&cn(n.__H,t)&&(n.__=e,n.i=t,A.__h.push(n))}function q(e){return mt=5,To(function(){return{current:e}},[])}function To(e,t){var n=vt(ze++,7);return cn(n.__H,t)&&(n.__=e(),n.__H=t,n.__h=e),n.__}function xo(){for(var e;e=Yn.shift();)if(e.__P&&e.__H)try{e.__H.__h.forEach(lt),e.__H.__h.forEach(qt),e.__H.__h=[]}catch(t){e.__H.__h=[],H.__e(t,e.__v)}}H.__b=function(e){A=null,gn&&gn(e)},H.__=function(e,t){e&&t.__k&&t.__k.__m&&(e.__m=t.__k.__m),Cn&&Cn(e,t)},H.__r=function(e){wn&&wn(e),ze=0;var t=(A=e.__c).__H;t&&(Mt===A?(t.__h=[],A.__h=[],t.__.forEach(function(n){n.__N&&(n.__=n.__N),n.i=n.__N=void 0})):(t.__h.forEach(lt),t.__h.forEach(qt),t.__h=[],ze=0)),Mt=A},H.diffed=function(e){vn&&vn(e);var t=e.__c;t&&t.__H&&(t.__H.__h.length&&(Yn.push(t)!==1&&bn===H.requestAnimationFrame||((bn=H.requestAnimationFrame)||Io)(xo)),t.__H.__.forEach(function(n){n.i&&(n.__H=n.i),n.i=void 0})),Mt=A=null},H.__c=function(e,t){t.some(function(n){try{n.__h.forEach(lt),n.__h=n.__h.filter(function(o){return!o.__||qt(o)})}catch(o){t.some(function(r){r.__h&&(r.__h=[])}),t=[],H.__e(o,n.__v)}}),yn&&yn(e,t)},H.unmount=function(e){$n&&$n(e);var t,n=e.__c;n&&n.__H&&(n.__H.__.forEach(function(o){try{lt(o)}catch(r){t=r}}),n.__H=void 0,t&&H.__e(t,n.__v))};var kn=typeof requestAnimationFrame=="function";function Io(e){var t,n=function(){clearTimeout(o),kn&&cancelAnimationFrame(t),setTimeout(e)},o=setTimeout(n,100);kn&&(t=requestAnimationFrame(n))}function lt(e){var t=A,n=e.__c;typeof n=="function"&&(e.__c=void 0,n()),A=t}function qt(e){var t=A;e.__c=e.__(),A=t}function cn(e,t){return!e||e.length!==t.length||t.some(function(n,o){return n!==e[o]})}function Zn(e,t){return typeof t=="function"?t(e):t}const Kt=ce.bind(ie);let et=null,ct=null;const So=2500,Uo=6e3;function Tn(e){return e?Uo:So}function me(e,t=null){const n={message:e,action:t};et?et(n):ct=n}function Lo(){const[e,t]=J({visible:!1,message:"",action:null,nonce:0}),n=q(null);z(()=>(et=a=>{t(u=>({visible:!0,message:a.message,action:a.action,nonce:u.nonce+1}))},ct&&(et(ct),ct=null),()=>{et=null}),[]),z(()=>{if(!e.visible)return;const a=setTimeout(()=>t(u=>({...u,visible:!1})),Tn(e.action));return n.current=a,()=>clearTimeout(a)},[e.nonce]);const o=()=>{n.current!==null&&(clearTimeout(n.current),n.current=null)},r=()=>{!e.visible||n.current!==null||(n.current=setTimeout(()=>t(a=>({...a,visible:!1})),Tn(e.action)))},s=()=>{e.action?.onClick&&e.action.onClick(),t(a=>({...a,visible:!1}))},i="toast"+(e.visible?" visible":"");return Kt`
    <div class=${i} onMouseEnter=${o} onMouseLeave=${r}>
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
      </svg>
      <span>${e.message}</span>
      ${e.action&&Kt` <button class="toast-action" onClick=${s}>${e.action.label}</button> `}
    </div>
  `}function Mo(){const e=document.getElementById("toastRoot");e&&qn(Kt`<${Lo} />`,e)}function ee(e){if(!e||!e.startsWith("chrome-extension://"))return e;try{const t=new URL(e);if(!t.pathname.endsWith("/suspended.html"))return e;const n=t.hash.startsWith("#")?t.hash.slice(1):"",o="&uri=";let r;const s=n.indexOf(o);if(s>=0)r=n.slice(s+o.length);else if(n.startsWith("uri="))r=n.slice(4);else return e;return decodeURIComponent(r)||e}catch{return e}}function Eo(e){if(!e||!e.startsWith("chrome-extension://"))return"";try{const t=new URL(e);if(!t.pathname.endsWith("/suspended.html"))return"";const o=(t.hash.startsWith("#")?t.hash.slice(1):"").match(/(?:^|&)ttl=([^&]*)/);return o&&decodeURIComponent(o[1])||""}catch{return""}}function he(e){return!!e&&e.groupId!=null&&e.groupId!==-1}const Xn={grey:"#5F6368",blue:"#1A73E8",red:"#D93025",yellow:"#F9AB00",green:"#1E8E3E",pink:"#FF8BCB",purple:"#A142F4",cyan:"#007B83",orange:"#FA903E"},xn=["#5a9cff","#ff9f43","#2ecc71","#d35400","#9b59b6","#16a085","#e74c3c","#34495e","#f39c12"];let je={};async function Ro(){if(!chrome.tabGroups){je={};return}try{const e=await chrome.tabGroups.query({}),t={};for(const n of e)t[n.id]=Xn[n.color]||"#999";je=t}catch{}}function Po(e){if(!e||e.id==null)return!1;const t=Xn[e.color]||"#999";return je[e.id]===t?!1:(je[e.id]=t,!0)}function Do(e){return e==null||e===-1?"transparent":je[e]?je[e]:xn[Math.abs(e)%xn.length]}function In(e,t){const n=e.url||"",o=ee(n)!==n,r=he(e);let s=0;return e.active&&e.windowId===t?s+=1e4:e.active&&(s+=5e3),r&&(s+=1e3),e.pinned&&(s+=500),o||(s+=200),e.windowId===t&&(s+=50),s-=(e.index||0)*.001,s}let _t=[];function yt(e){return e.map(t=>({url:ee(t.url||""),title:t.title||"",pinned:!!t.pinned,groupId:typeof t.groupId=="number"?t.groupId:-1,windowId:t.windowId,index:typeof t.index=="number"?t.index:void 0})).filter(t=>t.url&&!t.url.startsWith("chrome://")&&!t.url.startsWith("chrome-extension://"))}async function $t(){try{const[e,t]=await Promise.all([chrome.tabs.query({}),chrome.windows.getAll(),Ro()]),n=new Map(t.map(o=>[o.id,o.type]));_t=e.map(o=>{const r=o.url||"",s=ee(r),i=r!==s;let a=o.title||"";if(i){const d=Eo(r);d&&(a=d)}const u=n.get(o.windowId);return{id:o.id,url:s,rawUrl:r,suspended:i,title:a,favIconUrl:o.favIconUrl||"",windowId:o.windowId,active:o.active,pinned:o.pinned,groupId:typeof o.groupId=="number"?o.groupId:-1,isTabOut:Jn(r),isApp:u==="app"||u==="popup"}})}catch{_t=[]}}function Qn(){return _t.filter(e=>{const t=e.url||"";return!t.startsWith("chrome://")&&!t.startsWith("chrome-extension://")&&!t.startsWith("about:")&&!t.startsWith("edge://")&&!t.startsWith("brave://")})}function Ao(){return _t.filter(e=>{if(e.isTabOut)return!0;const t=e.url||"";return!t.startsWith("chrome://")&&!t.startsWith("chrome-extension://")&&!t.startsWith("about:")&&!t.startsWith("edge://")&&!t.startsWith("brave://")})}async function Ct(e,t={}){if(!e||e.length===0)return[];const{preserveGroups:n=!1}=t,o=new Set(e),s=(await chrome.tabs.query({})).filter(a=>!(n&&he(a))&&o.has(ee(a.url))),i=yt(s);return s.length>0&&await chrome.tabs.remove(s.map(a=>a.id)),await $t(),i}async function Et(e){if(!e)return!1;const t=await chrome.tabs.query({}),n=await chrome.windows.getCurrent(),o=ee(e);let r=t.filter(i=>i.url===e||ee(i.url)===o);if(r.length===0)try{const i=new URL(o).hostname;r=t.filter(a=>{try{return new URL(ee(a.url)).hostname===i}catch{return!1}})}catch{}if(r.length===0)return!1;const s=r.find(i=>i.windowId!==n.id)||r[0];return await chrome.tabs.update(s.id,{active:!0}),await chrome.windows.update(s.windowId,{focused:!0}),!0}async function Rt(e){if(!e)return!1;const t=await chrome.tabs.query({}),n=ee(e),o=t.filter(i=>i.url===e||ee(i.url)===n);if(o.length===0)return!1;let r=-1;try{r=(await chrome.windows.getCurrent()).id}catch{}const s=o.find(i=>i.windowId===r)||o[0];return await chrome.tabs.update(s.id,{active:!0}),await chrome.windows.update(s.windowId,{focused:!0}),!0}async function Pt(e){if(e)try{await chrome.tabs.create({url:e,active:!0})}catch{}}function Jn(e){const t=globalThis.chrome?.runtime?.id;if(e==="chrome://newtab/")return!0;if(!t)return!1;const n=`chrome-extension://${t}/index.html`;return e===n||e?.startsWith(`${n}?`)||e?.startsWith(`${n}#`)}async function eo(e,t=!0,n={}){const{preservePinned:o=!1,preservePinnedTabOut:r=!1}=n,s=await chrome.tabs.query({});let i=-1;try{i=(await chrome.windows.getCurrent()).id}catch{}const a=[];for(const d of e){const h=s.filter(f=>ee(f.url)===d);if(o||r){const f=h.filter(_=>_.pinned&&(o||Jn(_.url)));if(f.length>=1){const _=new Set(f.map(b=>b.id));for(const b of h)_.has(b.id)||a.push(b);continue}}if(!t){for(const f of h)a.push(f);continue}const l=h.filter(f=>he(f)),p=h.filter(f=>!he(f)),c=f=>f.slice().sort((_,b)=>In(b,i)-In(_,i));if(l.length>=1&&p.length>=1)for(const f of p)a.push(f);else if(p.length>=2){const f=c(p)[0];for(const _ of p)_.id!==f.id&&a.push(_)}else if(l.length>=2&&new Set(l.map(_=>_.groupId)).size===1){const _=c(l)[0];for(const b of l)b.id!==_.id&&a.push(b)}}const u=yt(a);return a.length>0&&await chrome.tabs.remove(a.map(d=>d.id)),await $t(),u}const to=260,no=304,oo=10;function Ho(e){return!!e&&(typeof e.onBeforePack=="function"||typeof e.onAfterPack=="function")}function Dt(e,t,n){const o=parseFloat(e.getPropertyValue(t));return Number.isFinite(o)&&o>0?o:n}function so(e){const t=getComputedStyle(e);return{minColWidth:Dt(t,"--masonry-min-col-width",to),idealColWidth:Dt(t,"--masonry-ideal-col-width",no),gap:Dt(t,"--masonry-gap",oo)}}function ro(e,{minColWidth:t=to,idealColWidth:n=no,gap:o=oo}={}){if(!Number.isFinite(e)||e<=0)return{colCount:1,colWidth:0};const r=Math.max(1,Math.floor((e+o)/(t+o)));let s=null;for(let i=1;i<=r;i++){const a=(e-o*(i-1))/i;if(a<t&&i>1)continue;const u=Math.abs(a-n);(!s||u<s.score||u===s.score&&i>s.colCount)&&(s={colCount:i,colWidth:a,score:u})}return s?{colCount:s.colCount,colWidth:s.colWidth}:{colCount:1,colWidth:e}}function Fo(e,t,n={}){return Number.isInteger(t)?ro(e,n).colCount!==t:!1}function Oo(e,{unpin:t=!1,lastColCounts:n=null}={}){const o=Array.isArray(e)?e:[e];for(const r of o)No(r,t,n)}function No(e,t,n){if(!e)return;const o=e.clientWidth;if(o===0)return;const r=Array.from(e.querySelectorAll(".domain-block:not(.closing)")).filter(h=>getComputedStyle(h).display!=="none");if(r.length===0){e.style.height="";return}const s=so(e),{colCount:i,colWidth:a}=ro(o,s),u=n?.get(e);(t||u!==i)&&(r.forEach(h=>delete h.dataset.masonryCol),n?.set(e,i)),r.forEach(h=>{h.style.position="absolute",h.style.width=`${a}px`});const d=new Array(i).fill(0);r.forEach(h=>{let l;const p=parseInt(h.dataset.masonryCol,10);if(Number.isInteger(p)&&p>=0&&p<i)l=p;else{l=0;for(let c=1;c<i;c++)d[c]<d[l]&&(l=c);h.dataset.masonryCol=String(l)}h.style.left=`${l*(a+s.gap)}px`,h.style.top=`${d[l]}px`,d[l]+=h.getBoundingClientRect().height+s.gap}),e.style.height=`${Math.max(...d)-s.gap}px`,requestAnimationFrame(()=>e.classList.add("is-packed"))}function Wo(...e){const t=Ho(e[e.length-1])?e.pop():{},n=e,{onBeforePack:o=null,onAfterPack:r=null}=t,s=q(new WeakMap),i=q(0),a=q(null);function u(){return n.map(p=>p.current)}function d({unpin:p=!1,animate:c=!1}={}){const f=u(),_=c&&o?o(f):null;Oo(f,{unpin:p,lastColCounts:s.current}),c&&r&&r(f,_)}function h(p){return p.some(c=>{if(!c||c.clientWidth===0)return!1;const f=s.current.get(c);return Fo(c.clientWidth,f,so(c))})}function l({unpin:p=!1,animate:c=!0}={}){cancelAnimationFrame(i.current),i.current=requestAnimationFrame(()=>d({unpin:p,animate:c}))}return z(()=>{if(typeof ResizeObserver!="function")return;let p=a.current;return p||(p=new ResizeObserver(()=>{const c=u();l({animate:h(c)})}),a.current=p),p.disconnect(),n.forEach(c=>{const f=c.current;f&&p.observe(f)}),()=>p.disconnect()},n.map(p=>p.current)),z(()=>()=>{cancelAnimationFrame(i.current),a.current?.disconnect()},[]),{packMissionsMasonryNow:d,scheduleMissionsMasonry:l}}let Ne=null,Yt=!1,Zt=null;function Go(e){if(Ne=e,Yt){Yt=!1;const t=Zt;Zt=null,Ne(t)}return()=>{Ne===e&&(Ne=null)}}function be(e={}){return Ne?Ne(e):(Yt=!0,Zt=e,Promise.resolve())}let Xt=null;async function Bo(){const e=Xt;if(!e||!e.tabs||e.tabs.length===0)return;Xt=null;const t=[];for(const s of e.tabs)try{const i=await chrome.tabs.create({url:s.url,windowId:s.windowId,pinned:s.pinned,active:!1});if(i&&i.id!=null&&t.push(i.id),s.groupId!==void 0&&s.groupId!==-1&&chrome.tabs.group)try{await chrome.tabs.group({tabIds:[i.id],groupId:s.groupId})}catch{}}catch{}await be({animateCards:!0});const n=e.tabs.length,o=t[0],r=`Restored ${n} tab${n!==1?"s":""}`;n===1&&o!=null?me(r,{label:"Switch",onClick:async()=>{try{const s=await chrome.tabs.get(o);await chrome.tabs.update(o,{active:!0}),await chrome.windows.update(s.windowId,{focused:!0})}catch{}}}):me(r)}function Ue(e,t){if(!e||e.length===0)return;Xt={tabs:e,at:Date.now()};const n=e.length;me(t||`Closed ${n} tab${n!==1?"s":""}`,{label:"Undo",onClick:Bo})}function zo(e){const t=[];function n(o){o&&(o.url&&t.push({id:o.id,url:o.url,rawUrl:o.url,suspended:!1,title:o.title||"",favIconUrl:"",windowId:1,active:!1,pinned:!1,groupId:-1,isTabOut:!1,isApp:!1,sourceType:"bookmark"}),Array.isArray(o.children)&&o.children.forEach(n))}return e.forEach(n),t}async function Sn(){if(!chrome.bookmarks?.getTree)return[];try{const e=await chrome.bookmarks.getTree();return zo(e)}catch{return[]}}const jo=30,Ve="1d",io="off",ao=[{value:io,label:"History off",days:0},{value:"1d",label:"Last day",days:1},{value:"7d",label:"Last week",days:7},{value:"30d",label:"Last month",days:30},{value:"90d",label:"Last 3 months",days:90}];function un(e=Ve){return e!==io}function Vo(e=Ve){return ao.find(t=>t.value===e)?.days||90}function qo(e){return(e||[]).filter(t=>t?.url&&!t.url.startsWith("chrome://")&&!t.url.startsWith("chrome-extension://")).map((t,n)=>({id:t.id||`history-${n}`,url:t.url,rawUrl:t.url,suspended:!1,title:t.title||"",favIconUrl:"",windowId:1,active:!1,pinned:!1,groupId:-1,isTabOut:!1,isApp:!1,sourceType:"history"}))}async function Ko(e="",t=Ve){const n=e.trim();if(!n||!un(t)||!globalThis.chrome?.history?.search)return[];try{const o=Date.now()-Vo(t)*24*60*60*1e3,r=await chrome.history.search({text:n,startTime:o,maxResults:jo});return qo(r)}catch{return[]}}async function Yo(e=""){const t=e.trim();if(!t||!globalThis.chrome?.history?.deleteUrl)return!1;try{return await chrome.history.deleteUrl({url:t}),!0}catch{return!1}}function Qt(e){const t=e?.favIconUrl||"";if(t.startsWith("data:"))return t;const n=e?.url||"";if(!n)return"";if(!globalThis.chrome?.runtime?.getURL)return t;const o=new URL(chrome.runtime.getURL("/_favicon/"));return o.searchParams.set("pageUrl",n),o.searchParams.set("size","32"),o.toString()}const Un={"github.com":"GitHub","www.github.com":"GitHub","gist.github.com":"GitHub Gist","youtube.com":"YouTube","www.youtube.com":"YouTube","music.youtube.com":"YouTube Music","x.com":"X","www.x.com":"X","twitter.com":"X","www.twitter.com":"X","reddit.com":"Reddit","www.reddit.com":"Reddit","old.reddit.com":"Reddit","substack.com":"Substack","www.substack.com":"Substack","medium.com":"Medium","www.medium.com":"Medium","linkedin.com":"LinkedIn","www.linkedin.com":"LinkedIn","stackoverflow.com":"Stack Overflow","www.stackoverflow.com":"Stack Overflow","news.ycombinator.com":"Hacker News","google.com":"Google","www.google.com":"Google","mail.google.com":"Gmail","docs.google.com":"Google Docs","drive.google.com":"Google Drive","calendar.google.com":"Google Calendar","meet.google.com":"Google Meet","gemini.google.com":"Gemini","chatgpt.com":"ChatGPT","www.chatgpt.com":"ChatGPT","chat.openai.com":"ChatGPT","claude.ai":"Claude","www.claude.ai":"Claude","code.claude.com":"Claude Code","notion.so":"Notion","www.notion.so":"Notion","figma.com":"Figma","www.figma.com":"Figma","slack.com":"Slack","app.slack.com":"Slack","discord.com":"Discord","www.discord.com":"Discord","wikipedia.org":"Wikipedia","en.wikipedia.org":"Wikipedia","amazon.com":"Amazon","www.amazon.com":"Amazon","netflix.com":"Netflix","www.netflix.com":"Netflix","spotify.com":"Spotify","open.spotify.com":"Spotify","vercel.com":"Vercel","www.vercel.com":"Vercel","npmjs.com":"npm","www.npmjs.com":"npm","developer.mozilla.org":"MDN","arxiv.org":"arXiv","www.arxiv.org":"arXiv","huggingface.co":"Hugging Face","www.huggingface.co":"Hugging Face","producthunt.com":"Product Hunt","www.producthunt.com":"Product Hunt","xiaohongshu.com":"RedNote","www.xiaohongshu.com":"RedNote","local-files":"Local Files"};function At(e){return e?e.charAt(0).toUpperCase()+e.slice(1):""}function Zo(e){return e?Un[e]?Un[e]:e.endsWith(".substack.com")&&e!=="substack.com"?At(e.replace(".substack.com",""))+"'s Substack":e.endsWith(".github.io")?At(e.replace(".github.io",""))+" (GitHub Pages)":e.replace(/^www\./,"").replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/,"").split(".").map(n=>At(n)).join(" "):""}function Ht(e){return e?(e=e.replace(/^\(\d+\+?\)\s*/,""),e=e.replace(/\s*\([\d,]+\+?\)\s*/g," "),e=e.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,""),e=e.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,""),e=e.replace(/\s+on X:\s*/,": "),e=e.replace(/\s*\/\s*X\s*$/,""),e.trim()):""}function Ft(e,t){if(!e||!t)return e||"";const n=Zo(t),o=t.replace(/^www\./,""),r=[" - "," | "," — "," · "," – "];for(const s of r){const i=e.lastIndexOf(s);if(i===-1)continue;const u=e.slice(i+s.length).trim().toLowerCase();if(u===o.toLowerCase()||u===n.toLowerCase()||u===o.replace(/\.\w+$/,"").toLowerCase()||o.toLowerCase().includes(u)||n.toLowerCase().includes(u)){const d=e.slice(0,i).trim();if(d.length>=5)return d}}return e}const Xo=/^\d{1,3}(\.\d{1,3}){3}$/,Qo=new Set(["github.io","gitlab.io","bitbucket.io","pages.dev","workers.dev","vercel.app","netlify.app","netlify.com","herokuapp.com","firebaseapp.com","web.app","appspot.com","azurewebsites.net","ngrok.io","ngrok-free.app","loca.lt","surge.sh","blogspot.com","wordpress.com","tumblr.com","co.uk","co.jp","co.kr","co.nz","co.in","com.au","com.br","com.cn","com.mx","ac.uk","gov.uk","edu.au"]);function Jo(e){if(!e)return"";if(Xo.test(e))return e;const t=e.split(".");if(t.length<=2)return e;const n=t.slice(-2).join(".");return Qo.has(n)?t.slice(-3).join("."):t.slice(-2).join(".")}function Ze(e,t){if(!e||!t||e===t)return"";const n="."+t;if(!e.endsWith(n))return"";const o=e.slice(0,-n.length);return o==="www"?"":o}const es=[{hostname:"github.com",extract:e=>{const t=e.pathname.match(/^\/([^/]+)\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?/);if(!t||new Set(["orgs","settings","notifications","marketplace","explore","pulls","issues","search","login","join","about","new","topics","trending","collections","events","sponsors","codespaces","account"]).has(t[1]))return null;const o=`${t[1]}/${t[2]}`,r=t[3]||"",s=t[4]||"";let i="other";return r==="pull"&&s?i="pull":r==="issues"?i="issue":r==="commits"||r==="commit"?i="commit":(r==="blob"||r==="tree")&&(i="code"),{key:o,label:o,category:i}}},{hostnameEndsWith:".atlassian.net",extract:e=>{const t=e.pathname.match(/^\/browse\/([A-Z][A-Z0-9]+)-\d+/);return t?{key:`jira:${t[1]}`,label:t[1],alwaysCluster:!0}:null}},{hostnameEndsWith:".atlassian.net",extract:e=>{const t=e.pathname.match(/^\/wiki\/spaces\/([^/]+)/);return t?{key:`wiki:${t[1]}`,label:t[1]}:null}},{hostname:"app.contentful.com",extract:e=>{const t=e.pathname.match(/^\/spaces\/([^/]+)\/environments\/([^/]+)/);return t?{key:`${t[1]}/${t[2]}`,label:t[2]}:null}},{hostname:"www.figma.com",extract:e=>{const t=e.pathname.match(/^\/(?:design|file)\/([^/]+)\/([^/?]+)/);if(!t)return null;let n;try{n=decodeURIComponent(t[2]).replace(/[_-]+/g," ").trim()}catch{n=t[2]}return{key:t[1],label:n||t[1]}}},{hostname:"www.reddit.com",extract:e=>{const t=e.pathname.match(/^\/r\/([^/]+)/);return t?{key:`r/${t[1]}`,label:`r/${t[1]}`}:null}},{hostname:"www.google.com",extract:e=>e.pathname!=="/search"?null:{key:"google:search",label:"Google Search"}}];function ts(e){if(!e)return null;let t;try{t=new URL(e)}catch{return null}const n=[...window.LOCAL_PATH_GROUPERS||[],...es];for(const o of n)if(o.hostname?t.hostname===o.hostname:o.hostnameEndsWith&&t.hostname.endsWith(o.hostnameEndsWith))try{const s=o.extract(t);if(s&&s.key&&s.label)return s}catch{}return null}const Jt="tabOutPinnedDomainsV1";function kt(e){return!!e&&typeof e=="string"&&!e.startsWith("__")}function Tt(e=[]){const t=new Set,n=[];for(const o of e)!kt(o)||t.has(o)||(t.add(o),n.push(o));return n}function ns(e=[],t){const n=Tt(e);return kt(t)?n.includes(t)?n.filter(o=>o!==t):[...n,t]:n}async function os(){if(typeof chrome>"u"||!chrome.storage?.local)return[];try{const e=await chrome.storage.local.get(Jt);return Tt(e[Jt])}catch{return[]}}async function ss(e=[]){typeof chrome>"u"||!chrome.storage?.local||await chrome.storage.local.set({[Jt]:Tt(e)})}function Ln(e){return e&&e.replace(/[A-Za-z0-9_]{15,}/g,t=>t.replace(/(.{5})(?=.)/g,"$1​"))}function Mn(e,t){if(!t||!e||e===t)return{segments:[e],stripped:!1};const n=[" — "," – "," - "," · "," | ",": "," "],o=c=>c.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),r=o(t),s="(?:"+n.map(o).join("|")+")",i=new RegExp(`(^|${s})(${r})`,"g"),a=[];let u;for(;(u=i.exec(e))!==null;)a.push({index:u.index,length:u[0].length,prefixSep:u[1]}),u.index===i.lastIndex&&i.lastIndex++;if(a.length===0)return{segments:[e],stripped:!1};const d=[];let h=0;for(const c of a){const f=e.slice(h,c.index);f&&d.push(f),c.prefixSep&&d.push(c.prefixSep),d.push({placeholder:!0}),h=c.index+c.length}const l=e.slice(h);return l&&d.push(l),d.some(c=>typeof c=="string"&&c.trim())?{segments:d,stripped:!0}:{segments:[e],stripped:!1}}function xt(e,t){if(!t)return!0;const n=t.toLowerCase(),o=e.title||"",r=e.isTabOut?o.replace(/^.+ - Tab Out$/i,"Tab Out"):o;let s=e.url||"";if(e.isTabOut)try{const u=new URL(s);u.search="",s=u.toString()}catch{}const i=r.toLowerCase(),a=s.toLowerCase();return i.includes(n)||a.includes(n)}function rs(e=Qn(),t=""){return t?e.filter(n=>!n.isApp).filter(n=>!he(n)).filter(n=>n.url&&!n.url.startsWith("chrome")&&!n.url.startsWith("about:")).filter(n=>xt(n,t)).map(n=>n.url):[]}function Ot({realTabs:e=Qn(),domainGroups:t=[],filter:n="",source:o="tabs"}={}){const r=n.length>0,s=r?e.filter(f=>!f.isApp&&xt(f,n)):e,i=new Set(e.map(f=>f.windowId)).size,a=new Set(s.map(f=>f.windowId)).size,u=o==="tabs",d=[],h=[],l=[];let p=0;for(const f of t){const _=En(f,{filter:n,mode:"matched",allowMutations:u});if(_.isHidden||(d.push({group:f,vm:_}),u&&(p+=_.closableExtras||0,_.closableDupeUrls?.length&&l.push(..._.closableDupeUrls))),!r)continue;const b=En(f,{filter:n,mode:"unmatched",allowMutations:u});b.isHidden||h.push({group:f,vm:b})}const c=u?rs(e,n):[];return{source:o,stats:{totalTabs:e.length,visibleTabs:s.length,totalWindows:i,visibleWindows:a,totalDomains:t.length,visibleDomains:d.length,dedupCount:p,filteredCloseCount:c.length,hasCards:t.length>0,filtering:r},matchedCards:d,unmatchedCards:h,showOtherTabs:h.length>0,globalDedupeUrls:l,filteredCloseUrls:c}}function is(e){const t=e.map(i=>{try{const a=new URL(i),u=a.pathname.split("/").filter(Boolean);return a.search&&u.push(a.search),a.hash&&u.push(a.hash),u}catch{return[]}}),n=Math.min(...t.map(i=>i.length));let o=0;for(let i=0;i<n;i++){const a=t[0][i];if(t.every(u=>u[i]===a))o=i+1;else break}let r=0;const s=n-o;for(let i=1;i<=s;i++){const a=t[0][t[0].length-i];if(t.every(u=>u[u.length-i]===a))r=i;else break}return t.map(i=>{const a=i.slice(o,i.length-r);if(a.length===0)return"/";let u="";for(const l of a)l.startsWith("?")||l.startsWith("#")?u+=l:u+=(u?"/":"")+l;const d=!a[0].startsWith("?")&&!a[0].startsWith("#");return(o>0?"…":"")+(d?"/":"")+u})}function En(e,{filter:t="",mode:n="matched",allowMutations:o=!0}={}){const r=e.tabs||[],s=t!=="",i=n==="unmatched"?"unmatched":"normal",a="domain-"+e.domain.replace(/[^a-z0-9]/g,"-"),u=e.domain==="__standalone-apps__";if(s&&u)return{stableId:a,isHidden:!0,displayMode:i,filtering:s};const d=s?r.filter(m=>{const v=xt(m,t);return n==="unmatched"?!v:v}):n==="unmatched"?[]:r;if(d.length===0)return{stableId:a,isHidden:!0,displayMode:i,filtering:s};const h=d.length,l=r.length,p=r.length>0&&r.every(m=>m.sourceType==="bookmark")?"bookmark":r.length>0&&r.every(m=>m.sourceType==="history")?"history result":"open tab",c=s&&h!==l?`${h}/${l}`:`${h}`,f=s?`${h} of ${l} ${p}${l!==1?"s":""} shown while filtering`:`${h} ${p}${h!==1?"s":""}`,_=e.domain==="__tab-out__",b=d.filter(m=>!he(m)&&!(_&&m.pinned)),g=b.length,y={},L={};for(const m of d){L[m.url]=(L[m.url]||0)+1,y[m.url]||(y[m.url]={total:0,ungrouped:0,groupIds:new Set});const v=y[m.url];v.total++,he(m)?v.groupIds.add(m.groupId):v.ungrouped++}const K=Object.entries(L).filter(([,m])=>m>1);function te(m){const v=y[m];if(!v)return 0;if(_){const S=d.filter(x=>x.url===m),E=S.filter(x=>x.pinned).length,B=S.length-E;return E>=1?B:B>=2?B-1:0}const I=v.total-v.ungrouped;return I>=1&&v.ungrouped>=1?v.ungrouped:I===0&&v.ungrouped>=2?v.ungrouped-1:I>=2&&v.groupIds.size===1?v.total-1:0}const F=K.map(([m])=>m).filter(m=>te(m)>0),ne=F.reduce((m,v)=>m+te(v),0),ae=F.map(m=>encodeURIComponent(m)).join(","),V=new Set,D=[];for(const m of d)V.has(m.url)||(V.add(m.url),D.push(m));function G(m){let v=e.domain;try{v=new URL(m.url).hostname}catch{}return Ft(Ht(m.title||""),v)}function Y(m){return G(m).toLowerCase()}D.sort((m,v)=>Y(m).localeCompare(Y(v),void 0,{numeric:!0}));const w=new Set,T=[];{const m=new Map;for(const v of D)try{const I=new URL(v.url);if(!Ze(I.hostname,e.domain))continue;const E=I.pathname+I.search+I.hash;m.has(E)||m.set(E,[]),m.get(E).push(v)}catch{}for(const v of m.values()){const I=new Set;for(const S of v)try{I.add(Ze(new URL(S.url).hostname,e.domain))}catch{}I.size<2||(T.push(v),v.forEach(S=>w.add(S.url)))}}const O=new Map;for(const m of D){if(w.has(m.url))continue;let v="";try{const I=new URL(m.url);I.hostname==="localhost"&&I.port?v=I.port:v=Ze(I.hostname,e.domain)}catch{}O.has(v)||O.set(v,[]),O.get(v).push(m)}const j=[...O.entries()].sort((m,v)=>m[0]===v[0]?0:m[0]===""?-1:v[0]===""?1:m[0].localeCompare(v[0])),oe=j.length>1,Z=j.length===1&&j[0][0]!==""?j[0][0]:"",Le=e.domain==="localhost",se=Le&&!!Z;function Q(m,v,I,S,E,{iconOnly:B=!1}={}){let x=null;try{x=new URL(m.url)}catch{}const N=x?x.hostname:e.domain,_e=Ft(Ht(m.title||""),N);let le="",P="";x&&v&&(x.hostname==="localhost"&&x.port?P=x.port:le=Ze(x.hostname,e.domain));const de=le||P,we=S||"",{segments:ke,stripped:De}=Mn(_e,E||we),Ye=ke.map(W=>typeof W=="string"?Ln(W):W),$=[de,_e,I].filter(Boolean).join(" · "),C=he(m);return{tabUrl:m.url,rawUrl:m.rawUrl||m.url,sourceType:m.sourceType||"tab",leadPrefix:de,pathGroupLabel:we,displaySegments:Ye,titleStripped:De,pathSuffix:I||"",tooltip:$,dupeCount:L[m.url]||1,faviconUrl:Qt(m),isGrouped:C,groupDotColor:C?Do(m.groupId):null,isApp:!!m.isApp,iconOnly:B,envs:null}}const M=5;function ge(m){return s||m.length<=M+1?{vis:m,hid:[]}:{vis:m.slice(0,M),hid:m.slice(M)}}if(u){const m=D.map(B=>Q(B,!1,"","","",{iconOnly:!0})),v=i==="unmatched"||!o?0:g,I=i==="unmatched"||!o?0:ne,S=i==="unmatched"||!o?[]:F,E=i==="unmatched"||!o?"":ae;return{stableId:a,isHidden:!1,displayMode:i,filtering:s,tabCount:h,totalTabCount:l,tabCountLabel:c,tabCountTitle:f,closableCount:v,closableCountLabel:g===h?`Close all ${g} tab${g!==1?"s":""}`:`Close ${g} ungrouped tab${g!==1?"s":""}`,closableDupeUrls:S,closableExtras:I,dupeUrlsEncoded:E,singleSubdomainKey:"",singleSubdomainIsPort:!1,displayName:e.label||"Apps",sections:[{key:"__apps__",sectionCount:h,sectionClosableUrls:i==="unmatched"||!o?[]:b.map(B=>B.url),showHeader:!1,isShared:!1,isPort:!1,hasFlat:!0,flatVisibleChips:m,flatHiddenChips:[],flatHiddenCount:0,clusters:[]}]}}function It(m){const v=m[0];let I=null;try{I=new URL(v.url)}catch{}const S=I?I.hostname:e.domain,E=Ft(Ht(v.title||""),S),{segments:B,stripped:x}=Mn(E,""),N=B.map(P=>typeof P=="string"?Ln(P):P),_e=m.map(P=>{let de="";try{de=Ze(new URL(P.url).hostname,e.domain)}catch{}return{prefix:de||"?",tabUrl:P.url,rawUrl:P.rawUrl||P.url}}).sort((P,de)=>P.prefix.localeCompare(de.prefix,void 0,{numeric:!0})),le=[_e.map(P=>P.prefix).join(" · "),E].filter(Boolean).join(" · ");return{tabUrl:v.url,rawUrl:v.rawUrl||v.url,sourceType:v.sourceType||"tab",leadPrefix:"",pathGroupLabel:"",displaySegments:N,titleStripped:x,pathSuffix:"",tooltip:le,dupeCount:1,faviconUrl:Qt(v),isGrouped:!1,groupDotColor:null,isApp:m.every(P=>P.isApp),envs:_e}}let $e=null;if(T.length>0){const m=T.slice().sort((x,N)=>Y(x[0]).localeCompare(Y(N[0]),void 0,{numeric:!0})),v=m.map(x=>It(x)),{vis:I,hid:S}=ge(v),E=o?m.flatMap(x=>x.filter(N=>!he(N)).map(N=>N.url)):[];$e={key:"__shared__",sectionCount:m.reduce((x,N)=>x+N.length,0),sectionClosableUrls:E,showHeader:!1,isShared:!0,hasFlat:!0,flatVisibleChips:I,flatHiddenChips:S,flatHiddenCount:S.length,clusters:[]}}const Me=j.map(([m,v])=>{const I=oe&&m!=="",S=!I&&!Z,E=new Map,B=new Map;for(const k of v){const U=G(k).toLowerCase();B.has(U)||B.set(U,[]),B.get(U).push(k)}for(const k of B.values()){if(k.length<2)continue;const U=is(k.map(ve=>ve.url));k.forEach((ve,He)=>E.set(ve.url,U[He]))}const x=new Map,N=new Map;for(const k of v){const U=ts(k.url);U&&(x.set(k.url,U),N.set(U.key,(N.get(U.key)||0)+1))}const _e=new Map;for(const[k,U]of x)!U.alwaysCluster&&N.get(U.key)<2||U.label===m||U.label===e.domain||_e.set(k,U.label);const le=new Map,P=[];for(const k of v){const U=_e.get(k.url);if(!U){P.push(k);continue}le.has(U)||le.set(U,[]),le.get(U).push(k)}const de=[...le.entries()].sort((k,U)=>k[0].localeCompare(U[0],void 0,{numeric:!0})),we={pull:0,issue:1,commit:2,code:3,other:4},ke=[];for(const[k,U]of de){const ve=U.filter(Te=>x.get(Te.url)?.category==="pull"),He=U.filter(Te=>x.get(Te.url)?.category!=="pull");if(ve.length>=2&&He.length>=1)ke.push({label:k,tabs:He,key:k,isPR:!1}),ke.push({label:k,tabs:ve,key:k+":pr",isPR:!0});else{const Te=ve.length===U.length&&U.length>0;ke.push({label:k,tabs:U,key:k,isPR:Te})}}const De=ke.map(({label:k,tabs:U,key:ve,isPR:He})=>{const Te=U.slice().sort((fe,_o)=>{const bo=we[x.get(fe.url)?.category]??we.other,go=we[x.get(_o.url)?.category]??we.other;return bo-go}),{vis:fo,hid:dn}=ge(Te),po=o?Te.filter(fe=>!he(fe)):[],ho=fo.map(fe=>Q(fe,S,E.get(fe.url)||"","",k)),mo=dn.map(fe=>Q(fe,S,E.get(fe.url)||"","",k));return{key:ve,label:k,isPR:He,count:U.length,closableUrls:po.map(fe=>fe.url),visibleChips:ho,hiddenChips:mo,hiddenCount:dn.length}}),{vis:Ye,hid:$}=ge(P),C=Ye.map(k=>Q(k,S,E.get(k.url)||"","")),W=$.map(k=>Q(k,S,E.get(k.url)||"","")),Ae=o?v.filter(k=>!he(k)).map(k=>k.url):[];return{key:m,sectionCount:v.length,sectionClosableUrls:Ae,showHeader:I,isShared:!1,isPort:Le,hasFlat:P.length>0,flatVisibleChips:C,flatHiddenChips:W,flatHiddenCount:$.length,clusters:De}});$e&&Me.unshift($e);const qe=g===h?`Close all ${g} tab${g!==1?"s":""}`:`Close ${g} ungrouped tab${g!==1?"s":""}`,Pe=e.label||e.domain.replace(/^www\./,""),ue=i==="unmatched",Ke=ue||!o?0:g,Ce=ue||!o?0:ne,St=ue||!o?[]:F,Ut=ue||!o?"":ae,Lt=ue?Me.map(m=>({...m,sectionClosableUrls:[],clusters:m.clusters.map(v=>({...v,closableUrls:[]}))})):Me;return{stableId:a,isHidden:!1,displayMode:i,filtering:s,tabCount:h,totalTabCount:l,tabCountLabel:c,tabCountTitle:f,closableCount:Ke,closableCountLabel:qe,closableDupeUrls:St,closableExtras:Ce,dupeUrlsEncoded:Ut,singleSubdomainKey:Z,singleSubdomainIsPort:se,displayName:Pe,sections:Lt}}function as(){return{customGroups:window.LOCAL_CUSTOM_GROUPS||[]}}function ot(e,{previousOrder:t=new Map,customGroups:n=[],pinnedDomains:o=[]}={}){const r={},s=[],i=[];function a(c){try{const f=new URL(c);return n.find(_=>(_.hostname?f.hostname===_.hostname:_.hostnameEndsWith?f.hostname.endsWith(_.hostnameEndsWith):!1)?_.pathPrefix?f.pathname.startsWith(_.pathPrefix):!0:!1)||null}catch{return null}}for(const c of e)try{if(c.isTabOut){i.push(c);continue}if(c.isApp){s.push(c);continue}const f=a(c.url);if(f){const g=f.groupKey;r[g]||(r[g]={domain:g,label:f.groupLabel,tabs:[]}),r[g].tabs.push(c);continue}let _;if(c.url&&c.url.startsWith("file://")?_="local-files":_=new URL(c.url).hostname,!_)continue;const b=Jo(_);r[b]||(r[b]={domain:b,tabs:[]}),r[b].tabs.push(c)}catch{}i.length>0&&(r["__tab-out__"]={domain:"__tab-out__",label:"New tabs",tabs:i}),s.length>0&&(r["__standalone-apps__"]={domain:"__standalone-apps__",label:"Apps",tabs:s});const u=Tt(o),d=new Map(u.map((c,f)=>[c,f]));function h(c){return c.domain==="__tab-out__"?0:c.domain==="__standalone-apps__"?1:c.pinned?2:3}const l=Object.values(r);l.forEach(c=>{c.pinned=kt(c.domain)&&d.has(c.domain)}),l.sort((c,f)=>{const _=h(c)-h(f);return _!==0?_:c.pinned&&f.pinned?d.get(c.domain)-d.get(f.domain):f.tabs.length-c.tabs.length});const p=c=>"domain-"+c.domain.replace(/[^a-z0-9]/g,"-");return l.sort((c,f)=>{const _=h(c)-h(f);if(_!==0)return _;if(c.pinned&&f.pinned)return d.get(c.domain)-d.get(f.domain);const b=t.get(p(c)),g=t.get(p(f));return b!==void 0&&g!==void 0?b-g:b!==void 0?-1:g!==void 0?1:0}),l}async function Rn(e=new Map,t="tabs",{pinnedDomains:n=[],bookmarkPreviousOrder:o=new Map,historyPreviousOrder:r=new Map,includeBookmarkMatches:s=!1,includeHistoryMatches:i=!1,searchQuery:a="",historyRange:u=Ve}={}){const d=as();if(t==="bookmarks"){const g=await Sn(),y=ot(g,{previousOrder:e,pinnedDomains:n,...d});return{realTabs:g,domainGroups:y,bookmarkTabs:[],bookmarkDomainGroups:[],bookmarkSearchReady:!1,historyTabs:[],historyDomainGroups:[],historySearchQuery:"",historyRange:Ve}}const h=i?a.trim():"",[,l,p]=await Promise.all([$t(),s?Sn():Promise.resolve([]),i?Ko(a,u):Promise.resolve([])]),c=Ao(),f=ot(c,{previousOrder:e,pinnedDomains:n,...d}),_=ot(l,{previousOrder:o,pinnedDomains:n,...d}),b=ot(p,{previousOrder:r,pinnedDomains:n,...d});return{realTabs:c,domainGroups:f,bookmarkTabs:l,bookmarkDomainGroups:_,bookmarkSearchReady:s,historyTabs:p,historyDomainGroups:b,historySearchQuery:h,historyRange:u}}const ls="tab-out:get-tab-history";function ut(){return{stackSize:0,maxSize:0,cursorIndex:-1,currentIndex:-1,previousIndex:-1,nextIndex:-1,activeTabId:null,activeWindowId:null,activeWasInserted:!1,entries:[]}}function cs(e,t){const n=Number.isInteger(e?.tabId)?e.tabId:-1,o=Number.isInteger(e?.windowId)?e.windowId:-1,r=String(e?.url||"");return{index:Number.isInteger(e?.index)?e.index:t,tabId:n,windowId:o,exists:!!e?.exists,active:!!e?.active,pinned:!!e?.pinned,discarded:!!e?.discarded,cursor:!!e?.cursor,current:!!e?.current,previousTarget:!!e?.previousTarget,nextTarget:!!e?.nextTarget,title:String(e?.title||(n===-1?"Unknown tab":`Tab ${n}`)),url:r,displayUrl:String(e?.displayUrl||r||(n===-1?"":`tab ${n}`)),favIconUrl:Qt({favIconUrl:String(e?.favIconUrl||""),url:r})}}function us(e){if(!e||!Array.isArray(e.entries))return ut();const t=e.entries.map(cs);return{stackSize:Number.isInteger(e.stackSize)?e.stackSize:t.length,maxSize:Number.isInteger(e.maxSize)?e.maxSize:0,cursorIndex:Number.isInteger(e.cursorIndex)?e.cursorIndex:-1,currentIndex:Number.isInteger(e.currentIndex)?e.currentIndex:-1,previousIndex:Number.isInteger(e.previousIndex)?e.previousIndex:-1,nextIndex:Number.isInteger(e.nextIndex)?e.nextIndex:-1,activeTabId:Number.isInteger(e.activeTabId)?e.activeTabId:null,activeWindowId:Number.isInteger(e.activeWindowId)?e.activeWindowId:null,activeWasInserted:!!e.activeWasInserted,entries:t}}async function ds(e){if(!globalThis.chrome?.runtime?.sendMessage)return ut();try{const t=await chrome.runtime.sendMessage(e);return t?.ok?us(t.snapshot):ut()}catch{return ut()}}function bt(){return ds({type:ls})}async function fs(e){if(!e?.exists||!Number.isInteger(e.tabId))return!1;try{return await chrome.tabs.update(e.tabId,{active:!0}),await chrome.windows.update(e.windowId,{focused:!0}),!0}catch{return!1}}async function ps(e){if(!e?.exists||!Number.isInteger(e.tabId))return{closed:!1,snapshot:[]};try{const n=(await chrome.tabs.query({})).find(r=>r.id===e.tabId);if(!n)return{closed:!1,snapshot:[]};const o=yt([n]);return await chrome.tabs.remove(e.tabId),{closed:!0,snapshot:o}}catch{return{closed:!1,snapshot:[]}}}const Fe=ce.bind(ie);function Xe(e,t){return`${t}${e===1?"":"s"}`}function hs({ready:e=!0,source:t="tabs",totalTabs:n,visibleTabs:o,totalWindows:r,visibleWindows:s,totalDomains:i,visibleDomains:a,dedupCount:u,filteredCloseCount:d,hasCards:h,filtering:l,onDedupAll:p,onCloseFiltered:c}){if(!e)return Fe`<div class="header-stats" aria-hidden="true"></div>`;const _=Xe(n,t==="bookmarks"?"bookmark":t==="history"?"history result":"tab"),b=l?`${o}/${n} ${_}`:`${n} ${_}`,g=s===r?`${r} ${Xe(r,"window")}`:`${s}/${r} ${Xe(r,"window")}`,y=a===i?`${i} ${Xe(i,"domain")}`:`${a}/${i} ${Xe(i,"domain")}`,L=`Close ${u} duplicate${u!==1?"s":""}`,K=`Close ${d} filtered tab${d!==1?"s":""}`;return Fe`
    <div class="header-stats">
      <span class="stat-primary">${b}</span>
      ${t==="tabs"&&u>0&&Fe`
        <button class="action-btn" title=${L} onClick=${p}>
          Dedupe ${u}
        </button>
      `}
      ${t==="tabs"&&Fe`
        <span class="stat-sep">·</span>
        <span>${g}</span>
      `}
      ${h&&Fe`
        <span class="stat-extras">
          <span class="stat-sep">·</span>
          <span class="section-count">${y}</span>
        </span>
      `}
      ${t==="tabs"&&d>0&&Fe`
        <button class="action-btn close-tabs" title=${K} onClick=${c}>
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
          Close ${d}
        </button>
      `}
    </div>
  `}const dt=ce.bind(ie);function ms({source:e,onSourceChange:t}){return dt`
    <div class="source-switch" role="tablist" aria-label="Dashboard source">
      <button
        type="button"
        class=${"source-switch-option"+(e==="tabs"?" is-active":"")}
        aria-selected=${e==="tabs"?"true":"false"}
        onClick=${()=>t("tabs")}
      >
        Tabs
      </button>
      <button
        type="button"
        class=${"source-switch-option"+(e==="bookmarks"?" is-active":"")}
        aria-selected=${e==="bookmarks"?"true":"false"}
        onClick=${()=>t("bookmarks")}
      >
        Bookmarks
      </button>
    </div>
  `}function _s(e,t=""){return!e||(e.key||"").toLowerCase()!=="k"||e.altKey||e.shiftKey?!1:/mac|iphone|ipad|ipod/i.test(t)?!!e.metaKey&&!e.ctrlKey:!!e.ctrlKey&&!e.metaKey}function bs({filter:e,filterFocusRequest:t=0,historyRange:n,showHistoryRange:o=!1,onFilterChange:r,onHistoryRangeChange:s,onCloseFiltered:i,onDedupAll:a,onSourceChange:u,source:d="tabs",ready:h=!0,...l}){const p=q(null);function c(g){r(g)}z(()=>{t<=0||p.current?.focus()},[t]),z(()=>{function g(y){_s(y,navigator.platform)&&(y.preventDefault(),p.current?.focus(),p.current?.select?.())}return window.addEventListener("keydown",g),()=>window.removeEventListener("keydown",g)},[]);const f="tab-filter-wrap"+(e?" has-value":""),_=d==="bookmarks"?"Filter bookmarks…":un(n)?"Filter tabs, bookmarks, history…":"Filter tabs and bookmarks…";function b(){c(""),p.current?.focus()}return dt`
    <header>
      <div class="header-row">
        <${hs}
          source=${d}
          ready=${h}
          totalTabs=${l.totalTabs}
          visibleTabs=${l.visibleTabs}
          totalWindows=${l.totalWindows}
          visibleWindows=${l.visibleWindows}
          totalDomains=${l.totalDomains}
          visibleDomains=${l.visibleDomains}
          dedupCount=${l.dedupCount}
          filteredCloseCount=${l.filteredCloseCount}
          hasCards=${l.hasCards}
          filtering=${l.filtering}
          onDedupAll=${a}
          onCloseFiltered=${i}
        />
        <div class="header-controls">
          <${ms} source=${d} onSourceChange=${u} />
          ${o&&dt`
            <select class="history-range-select" aria-label="History search range" value=${n} onChange=${g=>s?.(g.currentTarget.value)}>
              ${ao.map(g=>dt`<option value=${g.value}>${g.label}</option>`)}
            </select>
          `}
          <div class=${f}>
            <input
              ref=${p}
              type="search"
              class="tab-filter"
              autocomplete="off"
              spellcheck="false"
              placeholder=${_}
              value=${e}
              onInput=${g=>c(g.currentTarget.value)}
            />
            <button class="tab-filter-clear" type="button" title="Clear filter" aria-label="Clear filter" onClick=${b}>
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </header>
  `}const pe=ce.bind(ie);let Nt=null;function gs(e){return e?e.scrollHeight-e.clientHeight>1||e.scrollWidth-e.clientWidth>1:!1}function ft(e){e&&e.classList.toggle("chip-text-truncated",gs(e))}function ws(){return typeof ResizeObserver!="function"?null:(Nt||(Nt=new ResizeObserver(e=>{for(const t of e)ft(t.target)})),Nt)}function gt({chip:e,onHoverUrlChange:t=null}){const n=Array.isArray(e.envs)&&e.envs.length>0,o=e.sourceType==="history",r=e.sourceType==="bookmark"||o,s=n?e.envs[0]?.tabUrl||"":e.tabUrl||"",i=q(null);ln(()=>{const w=i.current;if(!w)return;let T=requestAnimationFrame(()=>ft(w));return()=>cancelAnimationFrame(T)}),z(()=>{const w=i.current;if(!w)return;const T=ws();T?.observe(w);const O=document.fonts,j=()=>ft(w);return O?.addEventListener?.("loadingdone",j),O?.ready?.then?.(()=>ft(w)),()=>{T?.unobserve(w),O?.removeEventListener?.("loadingdone",j)}},[]);function a(w){return w.key==="Enter"||w.key===" "}async function u(){const w=n?e.envs[0].tabUrl:e.tabUrl;if(w){if(r){await Rt(w)||await Pt(w);return}await Et(w)}}async function d(w){w.target===w.currentTarget&&a(w)&&(w.preventDefault(),await u())}async function h(w,T){if(w.stopPropagation(),!!T.tabUrl){if(r){await Rt(T.tabUrl)||await Pt(T.tabUrl);return}await Et(T.tabUrl)}}async function l(w,T){if(a(w)&&(w.preventDefault(),w.stopPropagation(),!!T.tabUrl)){if(r){await Rt(T.tabUrl)||await Pt(T.tabUrl);return}await Et(T.tabUrl)}}function p(w){t&&t(w||"")}function c(){p(s)}function f(w){w.relatedTarget&&w.currentTarget.contains(w.relatedTarget)||p("")}function _(){p(s)}function b(w){w.relatedTarget&&w.currentTarget.contains(w.relatedTarget)||p("")}function g(w){p(w.tabUrl)}function y(w){const T=w.currentTarget.closest(".page-chip");if(T&&w.relatedTarget&&T.contains(w.relatedTarget)){p(s);return}p("")}function L(w){p(w.tabUrl)}function K(w){const T=w.currentTarget.closest(".page-chip");if(T&&w.relatedTarget&&T.contains(w.relatedTarget)){p(s);return}p("")}async function te(w){w.stopPropagation();const T=w.currentTarget.closest(".page-chip"),O=await chrome.tabs.query({});let j=[],oe=0;if(n){const se=new Set(e.envs.map(M=>ee(M.tabUrl))),Q=new Set(e.envs.map(M=>M.tabUrl));j=O.filter(M=>Q.has(M.url)||se.has(ee(M.url))),oe=j.length}else{const se=ee(e.tabUrl),Q=O.filter(M=>M.url===e.tabUrl||ee(M.url)===se);j=Q.slice(0,1),oe=Q.length}const Z=j.length>0?yt(j):[];for(const se of j)try{await chrome.tabs.remove(se.id)}catch{}if(await $t(),(n||oe<=1)&&T&&(T.classList.add("closing"),await new Promise(se=>setTimeout(se,200))),p(""),await be({animateCards:!0}),Z.length>0){const se=n?`Closed ${Z.length} tab${Z.length!==1?"s":""} across subdomains`:"Tab closed";Ue(Z,se)}else me("Nothing to close")}async function F(w){w.stopPropagation();const T=w.currentTarget.closest(".page-chip"),O=Array.from(new Set(n?e.envs.map(Z=>Z.tabUrl).filter(Boolean):[e.tabUrl].filter(Boolean)));if(O.length===0)return;const oe=(await Promise.all(O.map(Z=>Yo(Z)))).filter(Boolean).length;if(oe===0){me("Could not delete history");return}T?.classList.add("closing"),await new Promise(Z=>setTimeout(Z,200)),p(""),await be({animateCards:!0}),me(oe===1?"History deleted":`Deleted ${oe} history items`)}const ne=e.isGrouped?`--group-color:${e.groupDotColor}`:null,ae=n?e.envs.map(w=>w.tabUrl).join(" "):e.tabUrl,V=e.dupeCount||1,D=V>1?`${V} open copies`:"",G=[e.tooltip,D].filter(Boolean).join(" · "),Y="chip-dupe-badge"+(V>9?" chip-dupe-badge-wide":"");return pe`
    <div
      class=${"page-chip clickable"+(n?" page-chip-folded":"")+(e.iconOnly?" page-chip-icon-only":"")}
      data-action="focus-tab"
      data-tab-url=${ae}
      title=${G}
      aria-label=${G}
      style=${ne}
      tabIndex="0"
      onClick=${u}
      onKeyDown=${d}
      onMouseEnter=${c}
      onMouseLeave=${f}
      onFocus=${_}
      onBlur=${b}
    >
      ${e.faviconUrl&&pe`
        <span class=${"chip-favicon-frame"+(e.isApp?" is-app":"")}>
          <img class="chip-favicon" src=${e.faviconUrl} alt="" />
          ${!e.iconOnly&&V>1&&pe`<span class=${Y} aria-hidden="true">${V}</span>`}
        </span>
      `}
      ${!e.iconOnly&&pe`
        <span class="chip-text" ref=${i}>
          ${n&&pe`
            <span class="chip-env-stack">
              ${e.envs.map(w=>pe`
                  <span
                    class="chip-env clickable"
                    data-action="focus-env"
                    data-tab-url=${w.tabUrl}
                    title=${`Focus ${w.prefix} tab`}
                    tabIndex="0"
                    onClick=${T=>h(T,w)}
                    onKeyDown=${T=>l(T,w)}
                    onMouseEnter=${()=>g(w)}
                    onMouseLeave=${y}
                    onFocus=${()=>L(w)}
                    onBlur=${K}
                  >
                    ${w.prefix}
                  </span>
                `)}
            </span>
          `}
          ${!n&&e.leadPrefix&&pe` <span class="chip-subdomain">${e.leadPrefix}</span> `}
          ${e.pathGroupLabel&&pe` <span class="chip-pathgroup">${e.pathGroupLabel}</span> `}
          ${e.displaySegments.map(w=>typeof w=="string"?w:pe`<span class="chip-strip-indicator" aria-hidden="true">~</span>`)}
          ${e.pathSuffix&&pe` <span class="chip-path">${e.pathSuffix}</span> `}
        </span>
      `}
      ${!e.iconOnly&&!n&&(!r||o)&&pe`
        <div class="chip-actions">
          <button
            class="chip-action chip-close"
            data-action=${o?"delete-history-url":"close-single-tab"}
            data-tab-url=${e.tabUrl}
            title=${o?"Delete from history":"Close this tab"}
            aria-label=${o?"Delete from history":"Close this tab"}
            onClick=${o?F:te}
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      `}
    </div>
  `}const Qe=ce.bind(ie);function vs({visibleChips:e,hiddenChips:t,hiddenCount:n,onHoverUrlChange:o=null,onLayoutChange:r=null}){const[s,i]=J(!1),a=e.length>0&&e.every(d=>d.iconOnly);function u(){i(!0),r&&r()}return Qe`
    <div class=${"flat-section"+(a?" flat-section-icons":"")} data-expanded=${s?"true":null}>
      ${e.map(d=>Qe` <${gt} key=${d.rawUrl} chip=${d} onHoverUrlChange=${o} /> `)}
      ${n>0&&Qe` <div class="page-chips-overflow">${t.map(d=>Qe` <${gt} key=${d.rawUrl} chip=${d} onHoverUrlChange=${o} /> `)}</div> `}
      ${!s&&n>0&&Qe`
        <div class="page-chip page-chip-overflow clickable" onClick=${u}>
          <span class="chip-text">+${n} more</span>
        </div>
      `}
    </div>
  `}const xe=ce.bind(ie);function ys({count:e,onClick:t}){const n=`Close ${e} tab${e!==1?"s":""}`;return xe`
    <button class="pathgroup-close-btn" title=${n} onClick=${t}>
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
      </svg>
    </button>
  `}function $s({label:e,isPR:t,count:n,closableUrls:o,visibleChips:r,hiddenChips:s,hiddenCount:i,onHoverUrlChange:a=null,onLayoutChange:u=null}){const[d,h]=J(!1);function l(){h(!0),u&&u()}async function p(){if(!o||o.length===0)return;const c=await Ct(o,{preserveGroups:!0});c.length>0&&Ue(c,`Closed ${c.length} tab${c.length!==1?"s":""}`),await be({animateCards:!0})}return xe`
    <div class="pathgroup-section" data-expanded=${d?"true":null}>
      <div class="pathgroup-header">
        <span class="chip-pathgroup" title=${e}>${e}</span>
        ${t&&xe`<span class="chip-pathgroup chip-pathgroup-pr">PRs</span>`}
        <span class="pathgroup-header-count">${n}</span>
        ${o&&o.length>0&&xe` <${ys} count=${o.length} onClick=${p} /> `}
      </div>
      ${r.map(c=>xe` <${gt} key=${c.rawUrl} chip=${c} onHoverUrlChange=${a} /> `)}
      ${i>0&&xe` <div class="page-chips-overflow">${s.map(c=>xe` <${gt} key=${c.rawUrl} chip=${c} onHoverUrlChange=${a} /> `)}</div> `}
      ${!d&&i>0&&xe`
        <div class="page-chip page-chip-overflow clickable" onClick=${l}>
          <span class="chip-text">+${i} more</span>
        </div>
      `}
    </div>
  `}const Oe=ce.bind(ie);function Cs({count:e,onClick:t}){const n=`Close ${e} tab${e!==1?"s":""}`;return Oe`
    <button class="subdomain-close-btn" title=${n} onClick=${t}>
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
      </svg>
    </button>
  `}function ks({subdomainKey:e,isShared:t,isPort:n,sectionCount:o,sectionClosableUrls:r,showHeader:s,hasFlat:i,flatVisibleChips:a,flatHiddenChips:u,flatHiddenCount:d,clusters:h,onHoverUrlChange:l=null,onLayoutChange:p=null}){const c=s&&r&&r.length>0,f=e;async function _(){if(!r||r.length===0)return;const b=await Ct(r,{preserveGroups:!0});b.length>0&&Ue(b,`Closed ${b.length} tab${b.length!==1?"s":""}`),await be({animateCards:!0})}return Oe`
    <div class="subdomain-section" data-shared=${t?"true":null} data-kind=${n?"port":null}>
      ${s&&Oe`
        <div class="subdomain-header">
          <span class="subdomain-header-name">${f}</span>
          <span class="subdomain-header-count">${o}</span>
          ${c&&Oe` <${Cs} count=${r.length} onClick=${_} /> `}
        </div>
      `}
      ${i&&Oe`
        <${vs}
          visibleChips=${a}
          hiddenChips=${u}
          hiddenCount=${d}
          onHoverUrlChange=${l}
          onLayoutChange=${p}
        />
      `}
      ${h.map(b=>Oe`
          <${$s}
            key=${b.key}
            label=${b.label}
            isPR=${b.isPR}
            count=${b.count}
            closableUrls=${b.closableUrls}
            visibleChips=${b.visibleChips}
            hiddenChips=${b.hiddenChips}
            hiddenCount=${b.hiddenCount}
            onHoverUrlChange=${l}
            onLayoutChange=${p}
          />
        `)}
    </div>
  `}const re=ce.bind(ie);function Ts({label:e,onClick:t}){return re`
    <button class="card-close-btn" data-action="close-domain-tabs" onClick=${t}>
      <span class="card-close-btn-text">${e}</span>
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
      </svg>
    </button>
  `}function xs({label:e,title:t}){const n=String(e??""),o=n.indexOf("/");return o>0?re`
      <span class="open-tabs-badge tab-count-badge tab-count-badge-filtered" title=${t}>
        <span class="tab-count-badge-current">${n.slice(0,o)}</span><span class="tab-count-badge-total">${n.slice(o)}</span>
      </span>
    `:re` <span class="open-tabs-badge tab-count-badge" title=${t}>${n}</span> `}function Is({count:e,dupeUrlsEncoded:t,onClick:n}){const o=`Dedupe ${e}`,r=`Close ${e} duplicate${e!==1?"s":""}`;return re`
    <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls=${t} title=${r} onClick=${n}>${o}</button>
  `}function Ss({domain:e,displayName:t,pinned:n,onClick:o}){const s=`${n?"Unpin":"Pin"} ${t}`;return re`
    <button
      type="button"
      class=${"domain-pin-btn"+(n?" is-pinned":"")}
      title=${s}
      aria-label=${s}
      aria-pressed=${n?"true":"false"}
      data-domain=${e}
      onClick=${o}
    >
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16h14v-.8a2 2 0 0 0-1.1-1.7l-1.8-.9a2 2 0 0 1-1.1-1.8V7h1a2 2 0 0 0 2-2V4H6v1a2 2 0 0 0 2 2h1v3.8Z" />
      </svg>
    </button>
  `}function Us({displayName:e}){return re`
    <span class="domain-fixed-indicator" role="img" aria-label=${`${e} is fixed at the top`} title=${`${e} is fixed at the top`}>
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16h14v-.8a2 2 0 0 0-1.1-1.7l-1.8-.9a2 2 0 0 1-1.1-1.8V7h1a2 2 0 0 0 2-2V4H6v1a2 2 0 0 0 2 2h1v3.8Z" />
      </svg>
    </span>
  `}function Ls({group:e,vm:t,filter:n="",onHoverUrlChange:o=null,onLayoutChange:r=null,onTogglePinnedDomain:s=null}){if(t.isHidden)return null;const i=e.domain==="__standalone-apps__",a=e.domain==="__standalone-apps__",u=e.domain==="__tab-out__"||e.domain==="__standalone-apps__",d=kt(e.domain)&&typeof s=="function";async function h(f){const _=f.currentTarget.closest(".domain-block"),g=(n?e.tabs.filter(L=>xt(L,n)):e.tabs).map(L=>L.url),y=await Ct(g,{preserveGroups:!0});_&&!n&&(_.classList.add("closing"),await new Promise(L=>setTimeout(L,250))),Ue(y,`Closed ${y.length} tab${y.length!==1?"s":""} from ${t.displayName}`),await be({animateCards:!0})}async function l(f){const _=f.currentTarget,b=(_.dataset.dupeUrls||"").split(",").map(L=>decodeURIComponent(L)).filter(Boolean);if(b.length===0)return;const g=await eo(b,!0,{preservePinned:e.domain==="__tab-out__"});_.classList.add("closing");const y=_.closest(".domain-block");y&&y.querySelectorAll(".chip-dupe-badge").forEach(L=>L.classList.add("closing")),await new Promise(L=>setTimeout(L,200)),Ue(g,`Closed ${g.length} duplicate${g.length!==1?"s":""}`),await be({animateCards:!0})}async function p(f){f.preventDefault(),await s?.(e.domain)}const c=`domain-block${t.displayMode==="unmatched"?" card-unmatched":""}${a?" domain-block-apps":""}${u?" domain-block-fixed":""}${e.pinned?" domain-block-pinned":""}`;return re`
    <div class=${c} data-domain-id=${t.stableId}>
      <header class="domain-header">
        <span class="mission-name">${t.displayName}</span>
        ${u&&re` <${Us} displayName=${t.displayName} /> `}
        ${d&&re` <${Ss} domain=${e.domain} displayName=${t.displayName} pinned=${!!e.pinned} onClick=${p} /> `}
        ${t.singleSubdomainKey&&re`
          <span class=${"mission-subdomain"+(t.singleSubdomainIsPort?" is-port":"")}>${t.singleSubdomainKey}</span>
        `}
        <${xs} label=${t.tabCountLabel} title=${t.tabCountTitle} />
        ${t.closableExtras>0&&re` <${Is} count=${t.closableExtras} dupeUrlsEncoded=${t.dupeUrlsEncoded} onClick=${l} /> `}
        ${!i&&t.closableCount>0&&re` <${Ts} label=${t.closableCountLabel} onClick=${h} /> `}
      </header>
      <div class="mission-card">
        <div class="mission-pages">
          ${t.sections.map(f=>re`
              <${ks}
                key=${f.key||"__root__"}
                subdomainKey=${f.key}
                isShared=${f.isShared}
                isPort=${f.isPort}
                sectionCount=${f.sectionCount}
                sectionClosableUrls=${f.sectionClosableUrls}
                showHeader=${f.showHeader}
                hasFlat=${f.hasFlat}
                flatVisibleChips=${f.flatVisibleChips}
                flatHiddenChips=${f.flatHiddenChips}
                flatHiddenCount=${f.flatHiddenCount}
                clusters=${f.clusters}
                onHoverUrlChange=${o}
                onLayoutChange=${r}
              />
            `)}
        </div>
      </div>
    </div>
  `}const We=ce.bind(ie);function Ms(e){return"domain-"+e.domain.replace(/[^a-z0-9]/g,"-")}function Es({source:e="tabs"}){return We`
    <div class="missions-empty-state">
      <div class="empty-title">No ${e==="bookmarks"?"bookmarks":e==="history"?"history results":"tabs"}.</div>
    </div>
  `}function Rs({query:e=""}){return We`
    <div class="missions-empty-state missions-empty-state-filter">
      <div class="empty-title">${e?`No matches for “${e}”.`:"No matches."}</div>
    </div>
  `}function st({cards:e,filter:t="",source:n="tabs",showEmptyState:o=!0,onHoverUrlChange:r=null,onLayoutChange:s=null,onTogglePinnedDomain:i=null}){return!e||e.length===0?o?t?We`<${Rs} query=${t} />`:We`<${Es} source=${n} />`:null:We`
    <${ye}>
      ${e.map(({group:a,vm:u})=>We` <${Ls}
            key=${Ms(a)}
            group=${a}
            vm=${u}
            filter=${t}
            onHoverUrlChange=${r}
            onLayoutChange=${s}
            onTogglePinnedDomain=${i}
          /> `)}
    </${ye}>
  `}const Se=ce.bind(ie);let Wt=null;function Ps(e){return e?e.scrollWidth-e.clientWidth>1:!1}function pt(e){e&&e.classList.toggle("history-entry-title-truncated",Ps(e))}function Ds(){return typeof ResizeObserver!="function"?null:(Wt||(Wt=new ResizeObserver(e=>{for(const t of e)pt(t.target)})),Wt)}function As(e){return["history-entry",e.current?"is-current":"",e.active?"is-active":"",e.previousTarget?"is-previous-target":"",e.nextTarget?"is-next-target":""].filter(Boolean).join(" ")}function Hs(e,t){const n=[];return e.active&&!e.current&&n.push("Active"),e.cursor&&!e.current&&n.push("Cursor"),t.activeWasInserted&&e.current&&n.push("Pending"),e.pinned&&n.push("Pinned"),n}function Fs(e,t,n){if(Number.isInteger(e.index)&&Number.isInteger(t?.currentIndex)&&t.currentIndex>=0){const o=e.index-t.currentIndex;return o<0?Se`<span>-</span><span>${Math.abs(o)}</span>`:String(o)}return String(n)}function Os({entry:e,indexLabel:t,snapshot:n,onSnapshotChange:o,onHoverUrlChange:r,onTabsChange:s}){const i=q(null);ln(()=>{const c=i.current;if(!c)return;const f=requestAnimationFrame(()=>pt(c));return()=>cancelAnimationFrame(f)}),z(()=>{const c=i.current;if(!c)return;const f=Ds();f?.observe(c);const _=document.fonts,b=()=>pt(c);return _?.addEventListener?.("loadingdone",b),_?.ready?.then?.(()=>pt(c)),()=>{f?.unobserve(c),_?.removeEventListener?.("loadingdone",b)}},[]);async function a(){if(s){await s();return}o?.(await bt())}async function u(){await fs(e)&&o?.(await bt())}async function d(c){c.stopPropagation();const f=c.currentTarget.closest(".history-entry-row"),_=await ps(e);if(!_.closed){me("Nothing to close");return}f?.classList.add("closing"),await new Promise(b=>setTimeout(b,160)),r?.(""),await a(),_.snapshot.length>0?Ue(_.snapshot,"Tab closed"):me("Tab closed")}function h(){r?.(e.url||"")}function l(){r?.("")}const p=Hs(e,n);return Se`
    <div
      class="history-entry-row"
      title=${e.title||e.displayUrl||e.url}
      onMouseEnter=${h}
      onMouseLeave=${l}
      onFocus=${h}
      onBlur=${l}
    >
      <span class="history-entry-index">${t}</span>
      <div class=${As(e)}>
        <button type="button" class="history-entry-main" disabled=${!e.exists} onClick=${u}>
          <span class=${"history-favicon-frame"+(e.favIconUrl?"":" is-empty")}>
            ${e.favIconUrl&&Se`<img class="history-favicon" src=${e.favIconUrl} alt="" />`}
          </span>
          <span class="history-entry-copy">
            <span class="history-entry-title" ref=${i}>${e.title}</span>
            ${p.length>0&&Se`
              <span class="history-entry-badges">
                ${p.map(c=>Se`<span class="history-badge">${c}</span>`)}
              </span>
            `}
          </span>
        </button>
        <div class="history-entry-actions">
          <button class="history-entry-close" type="button" disabled=${!e.exists} title="Close this tab" aria-label=${`Close ${e.title}`} onClick=${d}>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  `}function Ns({snapshot:e,onSnapshotChange:t,onHoverUrlChange:n,onTabsChange:o}){const s=(e?.entries||[]).slice().reverse();return Se`
    <section class="tab-history-panel" aria-label="Activation history">
      <div class="history-entry-list">
        ${s.length>0?s.map((i,a)=>Se`<${Os}
                  key=${`${i.windowId}:${i.tabId}:${i.index}`}
                  entry=${i}
                  indexLabel=${Fs(i,e,a+1)}
                  snapshot=${e}
                  onSnapshotChange=${t}
                  onHoverUrlChange=${n}
                  onTabsChange=${o}
                />`):Se`<div class="history-empty">No activation history yet.</div>`}
      </div>
    </section>
  `}const Ws=ce.bind(ie);function Gs({url:e,visible:t=!!e}){const n=t&&!!e,o="url-preview"+(n?" visible":"");return Ws`
    <div class=${o} aria-hidden=${n?"false":"true"}>
      <span>${e||""}</span>
    </div>
  `}const Ee=ce.bind(ie),en="focusFilter",tn="filter",Bs="‎",zs=200,js=600,Vs=120,qs=280,Ge=new WeakMap;function Ks(e=""){const t=e.trim();return t?`${t} - Tab Out`:Bs}function Ys(e=""){return new URLSearchParams(e).get(tn)||""}function Zs(e="",t={}){const{pathname:n="",search:o="",hash:r=""}=t,s=new URLSearchParams(o);e===""?s.delete(tn):s.set(tn,e);const i=s.toString();return`${n}${i?`?${i}`:""}${r||""}`}function Pn(){return Ys(window.location.search)}function Dn(e){const t=Zs(e,window.location),n=`${window.location.pathname}${window.location.search}${window.location.hash}`;t!==n&&window.history.replaceState(null,"",t)}function Xs(){return new URLSearchParams(window.location.search).get(en)==="1"}function Qs(){const e=new URLSearchParams(window.location.search);if(!e.has(en))return;e.delete(en);const t=e.toString(),n=`${window.location.pathname}${t?`?${t}`:""}${window.location.hash}`;window.history.replaceState(null,"",n)}function Gt(e){return"domain-"+e.domain.replace(/[^a-z0-9]/g,"-")}function lo(){return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches}function Js(e){const t=new Map;return lo()||e.forEach(n=>{n&&n.querySelectorAll(".domain-block:not(.closing)").forEach(o=>{const r=o.dataset.domainId;if(!r)return;const s=o.getBoundingClientRect();t.has(r)||t.set(r,[]),t.get(r).push({left:s.left,top:s.top})})}),t}function co(e){const t=Ge.get(e);t&&(cancelAnimationFrame(t.frameId),clearTimeout(t.timeoutId),e.removeEventListener("transitionend",t.onTransitionEnd),Ge.delete(e)),e.classList.remove("layout-moving","layout-moving-active"),e.style.transform=""}function uo(e){e.forEach(t=>{t&&t.querySelectorAll(".domain-block.layout-moving").forEach(co)})}function Bt(e){const t=Js(e);return uo(e),t}function er(e,t,n){const o=t?e.get(t):null;if(!o||o.length===0)return null;let r=0,s=1/0;o.forEach((a,u)=>{const d=a.left-n.left,h=a.top-n.top,l=d*d+h*h;l<s&&(s=l,r=u)});const[i]=o.splice(r,1);return o.length===0&&e.delete(t),i}function An(e,t){if(!t||t.size===0||lo())return;const n=[];e.forEach(o=>{o&&o.querySelectorAll(".domain-block:not(.closing)").forEach(r=>{const s=r.dataset.domainId;co(r);const i=r.getBoundingClientRect(),a=er(t,s,i);if(!a)return;const u=a.left-i.left,d=a.top-i.top;Math.abs(u)<1&&Math.abs(d)<1||(r.classList.add("layout-moving"),r.style.transform=`translate(${u}px, ${d}px)`,n.push(r))})}),n.length!==0&&(document.body.getBoundingClientRect(),n.forEach(o=>{function r(){Ge.get(o)===i&&(Ge.delete(o),o.removeEventListener("transitionend",s),o.classList.remove("layout-moving","layout-moving-active"),o.style.transform="")}function s(a){a.target===o&&a.propertyName==="transform"&&r()}const i={frameId:0,timeoutId:0,onTransitionEnd:s};o.addEventListener("transitionend",s),i.frameId=requestAnimationFrame(()=>{Ge.get(o)===i&&(o.classList.add("layout-moving-active"),o.style.transform="translate(0, 0)")}),i.timeoutId=setTimeout(r,qs+80),Ge.set(o,i)}))}function tr({initialDashboard:e=null}){const[t,n]=J(e),[o,r]=J("tabs"),[s,i]=J(Pn),[a,u]=J(Pn),[d,h]=J(Ve),[l]=J(()=>Xs()?1:0),[p,c]=J({url:"",visible:!1}),[f,_]=J(!1),[b,g]=J([]),[y,L]=J(!1),[K,te]=J(null),F=q(async()=>{}),ne=q(null),ae=q(0),V=q(null),D=q({tabs:new Map,bookmarks:new Map,history:new Map}),G=q(null),Y=q(null),w=q(null),T=q(null),O=q(null),j=t?.realTabs||[],oe=t?.domainGroups||[],Z=t?.bookmarkTabs||[],Le=t?.bookmarkDomainGroups||[],se=t?.historyTabs||[],Q=t?.historyDomainGroups||[],M=!!t,ge=un(d),{packMissionsMasonryNow:It,scheduleMissionsMasonry:$e}=Wo(Y,w,T,O,{onBeforePack:Bt,onAfterPack:An});function Me(){return[Y.current,w.current,T.current,O.current]}function qe(){V.current=Bt(Me())}function Pe(){ne.current!==null&&(clearTimeout(ne.current),ne.current=null)}function ue($){const C=$||"";if(C){Pe(),c(W=>W.url===C&&W.visible?W:{url:C,visible:!0});return}Pe(),ne.current=setTimeout(()=>{ne.current=null,c(W=>W.visible?{...W,visible:!1}:W)},Vs)}function Ke(){Pe(),c($=>$.url||$.visible?{url:"",visible:!1}:$)}F.current=async({animateCards:$=!1}={})=>{if(document.visibilityState!=="visible"||!y)return;$&&qe();const[C,W]=await Promise.all([Rn(D.current[o]||new Map,o,{pinnedDomains:b,bookmarkPreviousOrder:D.current.bookmarks||new Map,historyPreviousOrder:D.current.history||new Map,includeBookmarkMatches:o==="tabs"&&a!=="",includeHistoryMatches:o==="tabs"&&a!==""&&ge,searchQuery:a,historyRange:d}),bt()]);n(C),te(W)},z(()=>Go($=>F.current($)),[]),z(()=>{let $=!1;return os().then(C=>{$||(D.current={tabs:new Map,bookmarks:new Map,history:new Map},g(C),L(!0))}),()=>{$=!0}},[]),z(()=>{Qs()},[]),z(()=>{if(!M||!y||o!=="tabs"||!a)return;const $=!ge||t?.historySearchQuery===a.trim()&&t?.historyRange===d;if(t?.bookmarkSearchReady&&$)return;const C=requestAnimationFrame(()=>F.current());return()=>cancelAnimationFrame(C)},[a,d,ge,M,y,o,t?.bookmarkSearchReady,t?.historySearchQuery,t?.historyRange]),z(()=>{if(s===a)return;if(s===""){qe(),u("");return}const $=setTimeout(()=>{qe(),u(s)},zs);return()=>clearTimeout($)},[s,a]),z(()=>{document.title=Ks(s)},[s]),z(()=>{if(s===""){Dn("");return}const $=setTimeout(()=>Dn(s),js);return()=>clearTimeout($)},[s]),z(()=>{y&&(Ke(),requestAnimationFrame(()=>F.current()))},[b,y]),z(()=>()=>Pe(),[]),z(()=>{const $=G.current;if(!$)return;function C(){const W=$.scrollTop>0;_(Ae=>Ae===W?Ae:W)}return C(),$.addEventListener("scroll",C,{passive:!0}),()=>$.removeEventListener("scroll",C)},[]),ln(()=>{if(!M)return;Ke();const $=Me(),C=V.current;V.current=null,C||uo($),It({unpin:!0}),C&&An($,C)},[oe,Le,Q,a,o,M]);const Ce=Ot({realTabs:j,domainGroups:oe,filter:a,source:o}),St=o==="tabs"&&a&&t?.bookmarkSearchReady?Ot({realTabs:Z,domainGroups:Le,filter:a,source:"bookmarks"}):null,Ut=o==="tabs"&&a&&ge&&t?.historySearchQuery===a.trim()&&t?.historyRange===d?Ot({realTabs:se,domainGroups:Q,filter:a,source:"history"}):null;async function Lt(){const $=Ce.filteredCloseUrls;if($.length===0){me("Nothing to close");return}const C=await Ct($,{preserveGroups:!0});C.length>0?Ue(C,`Closed ${C.length} tab${C.length!==1?"s":""}`):me("Nothing to close"),await F.current({animateCards:!0})}async function m(){const $=Ce.globalDedupeUrls;if($.length===0)return;const C=await eo($,!0,{preservePinnedTabOut:!0});Ue(C,`Closed ${C.length} duplicate${C.length!==1?"s":""}`),await F.current({animateCards:!0})}async function v($){const C=ns(b,$);D.current={tabs:new Map,bookmarks:new Map,history:new Map},g(C);try{await ss(C)}catch{me("Could not save pinned domain"),g(b)}}async function I($){if($===o)return;const C=++ae.current,W=Bt(Me());Ke();const[Ae,k]=await Promise.all([Rn(D.current[$]||new Map,$,{pinnedDomains:b,bookmarkPreviousOrder:D.current.bookmarks||new Map,historyPreviousOrder:D.current.history||new Map,includeBookmarkMatches:$==="tabs"&&a!=="",includeHistoryMatches:$==="tabs"&&a!==""&&ge,searchQuery:a,historyRange:d}),bt()]);C===ae.current&&(V.current=W,n(Ae),te(k),r($))}const S=Ce.stats,E=Ce.matchedCards,B=Ce.unmatchedCards,x=St?.matchedCards||[],N=Ut?.matchedCards||[],_e=M&&Ce.showOtherTabs,le=M&&o==="tabs"&&!!a&&x.length>0,P=M&&o==="tabs"&&!!a&&N.length>0,de=M&&o==="tabs"&&!!a,we=!((le||P)&&E.length===0),ke="missions"+(E.length===0?" missions-empty":""),De=M&&o==="tabs",Ye=["dashboard-shell",De?"has-history":"",o==="bookmarks"?"is-bookmarks":""].filter(Boolean).join(" ");return z(()=>{D.current[o]=new Map(E.map(({group:$},C)=>[Gt($),C])),o==="tabs"&&x.length>0&&(D.current.bookmarks=new Map(x.map(({group:$},C)=>[Gt($),C]))),o==="tabs"&&N.length>0&&(D.current.history=new Map(N.map(({group:$},C)=>[Gt($),C])))},[oe,Le,Q,a,M,o]),Ee`
    <${ye}>
      <div class=${Ye}>
        ${De&&Ee`<${Ns}
          snapshot=${K}
          onSnapshotChange=${te}
          onHoverUrlChange=${ue}
          onTabsChange=${()=>F.current({animateCards:!0})}
        />`}
        <div class="dashboard-main">
          <div class=${"pinned-top"+(f?" is-scrolled":"")}>
            <${bs}
              source=${o}
              totalTabs=${S.totalTabs}
              visibleTabs=${S.visibleTabs}
              totalWindows=${S.totalWindows}
              visibleWindows=${S.visibleWindows}
              totalDomains=${S.totalDomains}
              visibleDomains=${S.visibleDomains}
              dedupCount=${S.dedupCount}
              filteredCloseCount=${S.filteredCloseCount}
              hasCards=${S.hasCards}
              filtering=${S.filtering}
              ready=${M}
              filter=${s}
              filterFocusRequest=${l}
              historyRange=${d}
              showHistoryRange=${de}
              onFilterChange=${i}
              onHistoryRangeChange=${h}
              onSourceChange=${I}
              onCloseFiltered=${Lt}
              onDedupAll=${m}
            />
          </div>

          <div class="scroll-region" ref=${G}>
            ${M&&Ee`
              <div class=${ke} id="openTabsMissions" ref=${Y}>
                <${st}
                  cards=${E}
                  filter=${a}
                  source=${o}
                  showEmptyState=${we}
                  onHoverUrlChange=${ue}
                  onLayoutChange=${$e}
                  onTogglePinnedDomain=${v}
                />
              </div>

              ${le&&Ee`
                <div class="missions-other missions-bookmarks" id="bookmarkMatchesSection">
                  <div class="missions-divider" role="separator">
                    <span class="missions-divider-rule"></span>
                    <span class="missions-divider-label">Bookmarks</span>
                    <span class="missions-divider-rule"></span>
                  </div>
                  <div class="missions" id="bookmarkMatchesMissions" ref=${w}>
                    <${st}
                      cards=${x}
                      filter=${a}
                      source="bookmarks"
                      showEmptyState=${!1}
                      onHoverUrlChange=${ue}
                      onLayoutChange=${$e}
                      onTogglePinnedDomain=${v}
                    />
                  </div>
                </div>
              `}

              ${P&&Ee`
                <div class="missions-other missions-history" id="historyMatchesSection">
                  <div class="missions-divider" role="separator">
                    <span class="missions-divider-rule"></span>
                    <span class="missions-divider-label">History</span>
                    <span class="missions-divider-rule"></span>
                  </div>
                  <div class="missions" id="historyMatchesMissions" ref=${T}>
                    <${st}
                      cards=${N}
                      filter=${a}
                      source="history"
                      showEmptyState=${!1}
                      onHoverUrlChange=${ue}
                      onLayoutChange=${$e}
                      onTogglePinnedDomain=${v}
                    />
                  </div>
                </div>
              `}

              ${_e&&Ee`
                <div class="missions-other" id="openTabsMissionsOther">
                  <div class="missions-divider" role="separator">
                    <span class="missions-divider-rule"></span>
                    <span class="missions-divider-label">Other tabs</span>
                    <span class="missions-divider-rule"></span>
                  </div>
                  <div class="missions" id="openTabsMissionsUnmatched" ref=${O}>
                    <${st}
                      cards=${B}
                      filter=${a}
                      source=${o}
                      showEmptyState=${!1}
                      onHoverUrlChange=${ue}
                      onLayoutChange=${$e}
                      onTogglePinnedDomain=${v}
                    />
                  </div>
                </div>
              `}
            `}
          </div>
        </div>
      </div>

      <${Gs} url=${p.url} visible=${p.visible} />
    </${ye}>
  `}function nr(e=null){const t=document.getElementById("appRoot");t&&qn(Ee`<${tr} initialDashboard=${e} />`,t)}let Hn=null,rt={};function X(e={}){rt={animateCards:!!(rt.animateCards||e.animateCards)},clearTimeout(Hn),Hn=setTimeout(()=>{const t=rt;rt={},be(t)},250)}function Je(){X({animateCards:!0})}chrome.tabs&&(chrome.tabs.onCreated.addListener(Je),chrome.tabs.onActivated.addListener(X),chrome.tabs.onRemoved.addListener(Je),chrome.tabs.onMoved.addListener(Je),chrome.tabs.onAttached.addListener(Je),chrome.tabs.onDetached.addListener(Je),chrome.tabs.onUpdated.addListener((e,t)=>{(t.title!==void 0||t.url!==void 0||t.favIconUrl!==void 0||t.groupId!==void 0||t.pinned!==void 0||t.discarded!==void 0)&&X({animateCards:t.url!==void 0||t.groupId!==void 0||t.pinned!==void 0||t.discarded!==void 0})}));chrome.windows&&chrome.windows.onFocusChanged.addListener(X);chrome.tabGroups&&(chrome.tabGroups.onCreated.addListener(X),chrome.tabGroups.onUpdated.addListener(e=>{Po(e)&&X()}),chrome.tabGroups.onRemoved.addListener(X),chrome.tabGroups.onMoved.addListener(X));chrome.bookmarks&&(chrome.bookmarks.onCreated.addListener(X),chrome.bookmarks.onRemoved.addListener(X),chrome.bookmarks.onChanged.addListener(X),chrome.bookmarks.onMoved.addListener(X),chrome.bookmarks.onChildrenReordered.addListener(X),chrome.bookmarks.onImportEnded?.addListener(X));chrome.history&&(chrome.history.onVisited.addListener(X),chrome.history.onVisitRemoved.addListener(X));document.addEventListener("visibilitychange",()=>{document.visibilityState==="visible"&&be()});document.addEventListener("error",e=>{const t=e.target;t&&t.tagName==="IMG"&&(t.style.display="none")},!0);async function or(){Mo(),nr(),document.visibilityState==="visible"&&be()}or();
//# sourceMappingURL=app.js.map

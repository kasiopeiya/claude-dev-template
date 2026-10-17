;(function () {
  function fallbackCopy(tex) {
    var ta = document.createElement('textarea')
    // eslint-disable-next-line id-denylist -- textarea の value は DOM の仕様が決めた名前
    ta.value = tex
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }

  function copyText(tex) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(tex).catch(function () {
        fallbackCopy(tex)
      })
    }
    fallbackCopy(tex)
    return Promise.resolve()
  }

  function makeButton(tex) {
    var btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'mb-math-copy'
    btn.setAttribute('aria-label', '数式の LaTeX をコピー')
    btn.textContent = 'copy'
    btn.addEventListener('click', function () {
      copyText(tex).then(function () {
        btn.textContent = 'copied'
        setTimeout(function () {
          btn.textContent = 'copy'
        }, 1200)
      })
    })
    return btn
  }

  function attachCopyUi(mathItem) {
    var root = mathItem.typesetRoot
    if (!root || !root.parentNode) return
    var wrap = document.createElement(mathItem.display ? 'div' : 'span')
    wrap.className = mathItem.display ? 'mb-math-block' : 'mb-math-inline'
    root.parentNode.insertBefore(wrap, root)
    wrap.appendChild(root)
    wrap.appendChild(makeButton(mathItem.math))
  }

  window.MathJax = {
    tex: {
      inlineMath: [['$', '$']],
      displayMath: [['$$', '$$']]
    },
    startup: {
      pageReady: function () {
        return MathJax.startup.defaultPageReady().then(function () {
          for (var mathItem of MathJax.startup.document.math) {
            attachCopyUi(mathItem)
          }
        })
      }
    }
  }
})()

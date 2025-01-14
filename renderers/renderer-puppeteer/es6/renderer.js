const promiseLimit = require('promise-limit')
const puppeteer = require('puppeteer')

const waitForRender = function (options) {
  options = options || {}

  return new Promise((resolve, reject) => {
    // Render when an event fires on the document.
    if (options.renderAfterDocumentEvent) {
      if (window['__PRERENDER_STATUS'] && window['__PRERENDER_STATUS'].__DOCUMENT_EVENT_RESOLVED) resolve('Render Event Already Resolved')
      document.addEventListener(options.renderAfterDocumentEvent, () => resolve('Render Event Fired'))
    }

    if (options.renderAfterTime) {
      setTimeout(() => resolve('Timeout'), options.renderAfterTime)
    }

    if (!options.renderAfterDocumentEvent && !options.renderAfterTime) {  
      resolve('No options specified')
    }
  })
  .then(reasonCode => {
    console.log('Render reason code:', reasonCode, 'Route:', document.location.pathname);
  });
}

class PuppeteerRenderer {
  constructor (rendererOptions) {
    this._puppeteer = null
    this._rendererOptions = rendererOptions || {}

    if (this._rendererOptions.maxConcurrentRoutes == null) this._rendererOptions.maxConcurrentRoutes = 0

    if (this._rendererOptions.inject && !this._rendererOptions.injectProperty) {
      this._rendererOptions.injectProperty = '__PRERENDER_INJECTED'
    }
  }

  async initialize () {
    try {
      // Workaround for Linux SUID Sandbox issues.
      if (process.platform === 'linux') {
        if (!this._rendererOptions.args) this._rendererOptions.args = []

        if (this._rendererOptions.args.indexOf('--no-sandbox') === -1) {
          this._rendererOptions.args.push('--no-sandbox')
          this._rendererOptions.args.push('--disable-setuid-sandbox')
        }
      }

      this._puppeteer = await puppeteer.launch(this._rendererOptions)
    } catch (e) {
      console.error(e)
      console.error('[Prerenderer - PuppeteerRenderer] Unable to start Puppeteer')
      // Re-throw the error so it can be handled further up the chain. Good idea or not?
      throw e
    }

    return this._puppeteer
  }

  async handleRequestInterception (page, baseURL) {
    await page.setRequestInterception(true)

    page.on('request', req => {
      // Skip third party requests if needed.
      if (this._rendererOptions.skipThirdPartyRequests) {
        if (!req.url().startsWith(baseURL)) {
          req.abort()
          return
        }
      }

      req.continue()
    })
  }

  async renderRoute (route, rootOptions, options, tries = 1) {
    const page = await this._puppeteer.newPage()

    try {
      if (options.consoleHandler) {
        page.on('console', message => options.consoleHandler(route, message))
      }

      if (options.inject) {
        await page.evaluateOnNewDocument(`(function () { window['${options.injectProperty}'] = ${JSON.stringify(options.inject)}; })();`)
      }

      const baseURL = `http://localhost:${rootOptions.server.port}`

      // Allow setting viewport widths and such.
      if (options.viewport) await page.setViewport(options.viewport)

      await this.handleRequestInterception(page, baseURL)

      // Hack just in-case the document event fires before our main listener is added.
      if (options.renderAfterDocumentEvent) {
        page.evaluateOnNewDocument(function (options) {
          window['__PRERENDER_STATUS'] = {}
          document.addEventListener(options.renderAfterDocumentEvent, () => {
            window['__PRERENDER_STATUS'].__DOCUMENT_EVENT_RESOLVED = true
          })
        }, this._rendererOptions)
      }

      const navigationOptions = (options.navigationOptions) ? { waituntil: 'networkidle0', ...options.navigationOptions } : { waituntil: 'networkidle0' }
      try {
        await page.goto(`${baseURL}${route}`, navigationOptions)
      } catch (e) {
        throw Error('failed to navigate.')
      }

    // Wait for some specific element exists
      const { renderAfterElementExists } = this._rendererOptions
      if (renderAfterElementExists && typeof renderAfterElementExists === 'string') {
        try {
          await page.waitForSelector(renderAfterElementExists)
        } catch (e) {
          throw Error('failed to wait for element to exist.')
        }
      }

      try {
        // Once this completes, it's safe to capture the page contents.
        await page.evaluate(waitForRender, this._rendererOptions)
      } catch (e) {
        throw Error('failed to evaluate.')
      }

      const result = {
        originalRoute: route,
        route: await page.evaluate('window.location.pathname'),
        html: await page.content()
      };

      if (!result.html.includes('data-server-rendered')) {
        throw new Error("Page wasn't rendered properly, was missing data-server-rendered attribute");
      }

      if (!page.isClosed()) {
        await page.close()
      }
      return result
    } catch (e) {
      if (!page.isClosed()) {
        await page.close()
      }

      if (tries < 5) {
        console.error(`Failed on try ${tries}:`, route + ',', e.message)
        return this.renderRoute(route, rootOptions, options, ++tries)
      } else {
        console.error('Failed:', route + ',', e.message)
        throw new Error(e)
      }
    }
  }

  async renderRoutes (routes, Prerenderer) {
    const rootOptions = Prerenderer.getOptions()
    const options = this._rendererOptions

    const limiter = promiseLimit(this._rendererOptions.maxConcurrentRoutes)

    const pagePromises = Promise.all(
      routes.map(
        (route, index) => limiter(
         async () => this.renderRoute(route, rootOptions, options)
        )
      )
    )

    return pagePromises
  }

  destroy () {
    try {
      this._puppeteer.close()
    } catch (e) {
      console.error('Puppeteer already destroyed')
    }
  }
}

module.exports = PuppeteerRenderer

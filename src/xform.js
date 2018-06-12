'use strict';

const jsdom = require( 'jsdom' );
const { JSDOM } = jsdom;
const utils = require( 'enketo-core/src/js/utils' );
const fs = require( 'fs' );
const path = require( 'path' );
const libxslt = require( 'libxslt' );
const libxmljs = libxslt.libxmljs;
const sheets = require( 'enketo-xslt' );
const xslModelSheet = libxslt.parse( sheets.xslModel );
const addXPathExtensionsOc = require( 'enketo-xpath-extensions-oc' );
const appearanceRules = require( './appearances' );

class XForm {

    constructor( xformStr, options = {} ) {
        this.options = options;
        if ( !xformStr || !xformStr.trim() ) {
            throw 'Empty form.';
        }
        this.xformStr = xformStr;
        this.dom = this._getDom();
        this.doc = this.dom.window.document;
    }

    get binds() {
        this._binds = this._binds || [ ...this.doc.querySelectorAll( 'bind' ) ];
        return this._binds;
    }

    get bindsWithCalc() {
        this._bindsWithCalc = this._bindsWithCalc || [ ...this.doc.querySelectorAll( 'bind[calculate]' ) ];
        return this._bindsWithCalc;
    }

    get formControls() {
        // TODO: wrong to use h: namespace prefix without resolver here!
        // fix in JSDom might be forthcoming: 
        // * https://github.com/jsdom/jsdom/issues/2159, 
        // * https://github.com/jsdom/jsdom/issues/2028
        // doc.evaluate does not support namespaces at all (nsResolver is not used) in JSDom, hence this clever not() trick
        // to use querySelectorAll instead.
        this._formControls = this._formControls || [ ...this.doc.querySelectorAll( 'h\\:body *:not(item):not(label):not(hint):not(value):not(itemset):not(output)' ) ];
        return this._formControls;
    }

    get NAMESPACES() {
        return {
            '': 'http://www.w3.org/2002/xforms',
            h: 'http://www.w3.org/1999/xhtml',
            oc: 'http://openclinica.org/xforms',
            odk: 'http://opendatakit.org/xforms',
            enk: 'http://enketo.org/xforms',
            orx: 'http://openrosa.org/xforms',
            xsd: 'http://www.w3.org/2001/XMLSchema',
        };
    }

    bind( nodeset ) {
        return this.doc.querySelector( `bind[nodeset="${nodeset}"]` );
    }

    nsPrefixResolver( ns ) {
        let prefix = null;
        if ( !ns ) {
            return prefix;
        }
        Object.entries( this.NAMESPACES ).some( obj => {
            if ( obj[ 1 ] === ns ) {
                prefix = obj[ 0 ];
                return true;
            }
        } );
        return prefix;
    }

    // The reason this is not included in the constructor is to separate different types of errors,
    // and keep the constructor just for XML parse errors.
    parseModel() {
        // Be careful here, the pkg module to create binaries is surprisingly sophisticated, but the paths cannot be dynamic.
        const scriptContent = fs.readFileSync( path.join( __dirname, '../build/FormModel-bundle.js' ), { encoding: 'utf-8' } );

        // This window is not to be confused with this.dom.window which contains the XForm.
        const window = this._getWindow( scriptContent );

        // Disable the jsdom evaluator
        window.document.evaluate = undefined;

        // Get a serialized model with namespaces in locations that Enketo can deal with.
        const modelStr = this._extractModelStr().root().get( '*' ).toString( false );
        const external = this._getExternalDummyContent();

        // Instantiate an Enketo Core Form Model
        this.model = new window.FormModel( { modelStr: modelStr, external: external } );

        // Add custom XPath functions
        if ( this.options.openclinica ) {
            this.model.bindJsEvaluator( addXPathExtensionsOc );
        }

        // Initialize form model
        let loadErrors = this.model.init();

        if ( loadErrors.length ) {
            throw loadErrors;
        }
    }

    enketoEvaluate( expr, type = 'string', contextPath = null ) {
        try {
            if ( !this.model ) {
                console.log( 'Unexpectedly, there is no model when enketoEvaluate is called, creating one.' );
                this.parseModel();
            }
            // Note that the jsdom XPath evaluator was disabled in parseModel.
            // So we are certain to be testing Enketo's own XPath evaluator.
            let newExpr = this._stripJrChoiceName( expr );
            return this.model.evaluate( newExpr, type, contextPath );
        } catch ( e ) {
            throw this._cleanXPathException( e );
        }
    }

    checkStructure( warnings, errors ) {
        const rootEl = this.doc.documentElement;
        const rootElNodeName = rootEl.nodeName;
        if ( !( /^[A-z]+:html$/.test( rootElNodeName ) ) ) {
            errors.push( 'Root element should be <html>.' );
        }
        if ( rootEl.namespaceURI !== this.NAMESPACES.h ) {
            errors.push( 'Root element has incorrect namespace.' );
        }

        let headEl;
        let bodyEl;
        for ( let el of rootEl.children ) {
            if ( /^[A-z]+:head$/.test( el.nodeName ) ) {
                headEl = el;
            } else if ( /^[A-z]+:body$/.test( el.nodeName ) ) {
                bodyEl = el;
            }
        }
        if ( !headEl ) {
            errors.push( 'No head element found as child of <html>.' );
        }
        if ( headEl && headEl.namespaceURI !== this.NAMESPACES.h ) {
            errors.push( 'Head element has incorrect namespace.' );
        }
        if ( !bodyEl ) {
            errors.push( 'No body element found as child of <html>.' );
        }
        if ( bodyEl && bodyEl.namespaceURI !== this.NAMESPACES.h ) {
            errors.push( 'Body element has incorrect namespace.' );
        }

        let modelEl;
        if ( headEl ) {
            for ( let el of headEl.children ) {
                if ( /^([A-z]+:)?model$/.test( el.nodeName ) ) {
                    modelEl = el;
                    break;
                }
            }
            if ( !modelEl ) {
                errors.push( 'No model element found as child of <head>.' );
            }
            if ( modelEl && modelEl.namespaceURI !== this.NAMESPACES[ '' ] ) {
                errors.push( 'Model element has incorrect namespace.' );
            }
        }

        let primInstanceEl;
        if ( modelEl ) {
            for ( let el of modelEl.children ) {
                if ( /^([A-z]+:)?instance$/.test( el.nodeName ) ) {
                    primInstanceEl = el;
                    break;
                }
            }
            if ( !primInstanceEl ) {
                errors.push( 'No primary instance element found as first instance child of <model>.' );
            }
            if ( primInstanceEl && primInstanceEl.namespaceURI !== this.NAMESPACES[ '' ] ) {
                errors.push( 'Primary instance element has incorrect namespace.' );
            }
        }

        if ( primInstanceEl ) {
            const children = primInstanceEl.children;
            if ( children.length === 0 ) {
                errors.push( 'Primary instance element has child.' );
            } else if ( children.length > 1 ) {
                errors.push( 'Primary instance element has more than 1 child.' );
            }
            if ( children && !children[ 0 ].id ) {
                errors.push( `Data root node <${children[0].nodeName}> has no id attribute.` );
            }
        }

        // ODK Build bug
        if ( this.doc.querySelector( 'group:not([ref])' ) ) {
            warnings.push( 'Found <group> without ref attribute. This might be fine as long as the group has no relevant logic.' );
        }

        // ODK Build output
        if ( this.doc.querySelector( 'group:not([ref]) > repeat' ) ) {
            warnings.push( 'Found <repeat> that has a parent <group> without a ref attribute. ' +
                'If the repeat has relevant logic, this will make the form very slow.' );
        }
    }

    checkBinds( warnings, errors ) {
        // Check for use of form controls with calculations that are not readonly
        this.bindsWithCalc
            .filter( this._withFormControl.bind( this ) )
            .filter( bind => {
                const readonly = bind.getAttribute( 'readonly' );
                // TODO: the check for true() should be probably be done in XPath,
                // using XPath boolean conversion rules.
                return !readonly || readonly.trim() !== 'true()';
            } )
            .map( this._nodeNames.bind( this ) )
            .forEach( nodeName => errors.push( `Question "${nodeName}" has a calculation that is not set to readonly.` ) );
    }

    checkAppearances( warnings, errors ) {
        this.formControls
            .forEach( control => {
                const appearanceVal = control.getAttribute( 'appearance' );
                if ( !appearanceVal || appearanceVal.indexOf( 'ex:' ) === 0 ) {
                    return;
                }
                const appearances = appearanceVal.split( ' ' );
                appearances.forEach( appearance => {
                    let rules = appearanceRules[ appearance ];
                    if ( typeof rules === 'string' ) {
                        rules = appearanceRules[ rules ];
                    }
                    const ref = control.getAttribute( 'ref' );
                    if ( !ref ) {
                        errors.push( 'Question found in body that has no ref attribute' );
                        return;
                    }
                    const nodeName = ref.substring( ref.lastIndexOf( '/' ) + 1 ); // in model!
                    const controlNsPrefix = this.nsPrefixResolver( control.namespaceURI );
                    const bindEl = this.bind( ref );
                    const controlName = controlNsPrefix && /:/.test( control.nodeName ) ? controlNsPrefix + ':' + control.nodeName.split( ':' )[ 1 ] : control.nodeName;
                    let dataType = bindEl ? bindEl.getAttribute( 'type' ) : 'string';
                    // Convert ns prefix to properly evaluate XML Schema datatypes regardless of namespace prefix used in XForm.
                    const typeValNs = /:/.test( dataType ) ? bindEl.lookupNamespaceURI( dataType.split( ':' )[ 0 ] ) : null;
                    dataType = typeValNs ? `${this.nsPrefixResolver(typeValNs)}:${dataType.split(':')[1]}` : dataType;
                    if ( !rules ) {
                        warnings.push( `Appearance "${appearance}" for question "${nodeName}" is not supported` );
                        return;
                    }
                    if ( rules.controls && !rules.controls.includes( controlName ) ) {
                        warnings.push( `Appearance "${appearance}" for question "${nodeName}" is not valid for this question type (${control.nodeName})` );
                        return;
                    }
                    if ( rules.types && !rules.types.includes( dataType ) ) {
                        // Only check types if controls check passed.
                        // TODO check namespaced types when it becomes applicable (for XML Schema types).
                        warnings.push( `Appearance "${appearance}" for question "${nodeName}" is not valid for this data type (${dataType})` );
                        return;
                    }
                    // TODO: if an appearance is only valid when another appearance is used (e.g. no-ticks)

                    // switched off when warnings are output as errors (for OC) - may need different approach
                    if ( rules.preferred && warnings !== errors ) {
                        warnings.push( `Appearance "${appearance}" for question "${nodeName}" is deprecated, use "${rules.preferred}" instead` );
                    }
                    // Possibilities for future additions:
                    // - check accept/mediaType
                    // - check conflicting combinations of appearances
                } );

            } );
    }

    checkOpenClinicaRules( warnings, errors ) {
        const CLINICALDATA_REF = /instance\(\s*(["'])((?:(?!\1)clinicaldata))\1\s*\)/;

        // Check for use of external data in instance "clinicaldata"
        this.bindsWithCalc
            .filter( this._withoutFormControl.bind( this ) )
            .filter( bind => {
                // If both are true we have found an error (in an efficient manner)
                return CLINICALDATA_REF.test( bind.getAttribute( 'calculate' ) ) &&
                    bind.getAttributeNS( this.NAMESPACES.oc, 'external' ) !== 'clinicaldata';
            } )
            .map( this._nodeNames.bind( this ) )
            .forEach( nodeName => errors.push( `Found calculation for "${nodeName}" that refers to ` +
                'external clinicaldata without the required "external" attribute in the correct namespace.' ) );

        this.bindsWithCalc
            .filter( bind => bind.getAttributeNS( this.NAMESPACES.oc, 'external' ) === 'clinicaldata' )
            .filter( bind => {
                const calculation = bind.getAttribute( 'calculate' );
                return !calculation || !CLINICALDATA_REF.test( calculation );
            } )
            .map( this._nodeNames.bind( this ) )
            .forEach( nodeName => errors.push( `Found bind with clinicaldata attribute for "${nodeName}" that does not ` +
                'have a calculation referring to instance(\'clinicaldata\').' ) );
    }

    /*
     * Obtain an isolated "browser" window context and optionally, run a script in this context.
     */
    _getWindow( scriptContent = '' ) {
        // Let any logging by Enketo Core fall into the abyss.
        const virtualConsole = new jsdom.VirtualConsole();
        const { window } = new JSDOM( '', { runScripts: 'dangerously', virtualConsole: virtualConsole } );
        const scriptEl = window.document.createElement( 'script' );
        scriptEl.textContent = scriptContent;
        window.document.body.appendChild( scriptEl );
        return window;
    }

    _getExternalDummyContent() {
        let external = [];
        this.doc.querySelectorAll( 'instance[id][src]' ).forEach( instance => {
            external.push( { id: instance.id, xmlStr: '<something/>' } );
        } );
        return external;
    }

    /*
     * Since this is such a weird function that queries the body of the XForm,
     * and cannot be evaluated in XPath, and I hate it, we just strip it out.
     */
    _stripJrChoiceName( expr ) {
        utils.parseFunctionFromExpression( expr, 'jr:choice-name' ).forEach( choiceFn => {
            expr = expr.replace( choiceFn[ 0 ], '"a"' );
        } );
        return expr;
    }

    /*
     * This discombulated heavy-handed method ensures that the namespaces are included in their expected locations,
     * at least where Enketo Core knows how to handle them.
     */
    _extractModelStr() {
        let doc = libxmljs.parseXml( this.xformStr );
        return xslModelSheet.apply( doc );
    }

    _getDom() {
        try {
            return new JSDOM( this.xformStr, {
                contentType: 'text/xml'
            } );
        } catch ( e ) {
            throw this._cleanXmlDomParserError( e );
        }
    }

    /**
     * Determines whether bind element has corresponding input form control.
     * 
     * @param {Element} bind The XForm <bind> element
     * @returns {boolean}
     * @memberof XForm
     */
    _withFormControl( bind ) {
        const nodeset = bind.getAttribute( 'nodeset' );
        // We are not checking for <group> and <repeat>,
        // as the purpose of this function is to identify calculations without form control
        return !!this.doc.querySelector( `input[ref="${nodeset}"], select[ref="${nodeset}"], ` +
            `select1[ref="${nodeset}"], trigger[ref="${nodeset}"]` );
    }

    _withoutFormControl( bind ) {
        return !this._withFormControl( bind );
    }

    _nodeNames( bind ) {
        const path = bind.getAttribute( 'nodeset' );
        return path.substring( path.lastIndexOf( '/' ) + 1 );
    }

    _cleanXmlDomParserError( error ) {
        if ( this.options.debug ) {
            return error;
        }
        let parts = error.message.split( '\n' );
        return parts[ 0 ] + ' ' + parts.splice( 1, 4 ).join( ', ' );
    }

    _cleanXPathException( error ) {
        if ( this.options.debug ) {
            return error;
        }
        let parts = [ error.message.split( '\n' )[ 0 ], error.name, error.code ]
            .filter( part => !!part );

        parts[ 0 ] = parts[ 0 ]
            .replace( /Function "{}(.*)"/g, 'Function "$1"' )
            .replace( /\/model\/instance\[1\]/g, '' )
            .replace( /\(line: undefined, character: undefined\)/g, '' );
        // '. ,' => ','
        return parts.join( ', ' ).replace( /\.\s*,/g, ',' );
    }

}

module.exports = {
    XForm: XForm
};